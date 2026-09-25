import { describe, expect, it, vi } from 'vitest';

import {
  LLMError,
  type CallMeta,
  type StreamChunk,
  type WireStreamChunk,
} from '../../../src/index.js';
import { VernLLM } from '../../../src/vernLLM.js';
import { FakeApiError, createMockStreamingClient } from '../../helpers.js';

type Step = WireStreamChunk | Error | { waitMs: number };

/** A stream that plays `steps` in order: chunks are yielded, errors thrown, waits slept. */
function scripted(steps: Step[]): () => AsyncIterable<WireStreamChunk> {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const step of steps) {
        if (step instanceof Error) throw step;
        if ('waitMs' in step) {
          await new Promise((resolve) => setTimeout(resolve, step.waitMs));
          continue;
        }
        yield step;
      }
    },
  });
}

const ping: WireStreamChunk = { type: 'ping' };
const text = (delta: string): WireStreamChunk => ({ type: 'text-delta', delta });

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

describe('stream failure before the first content chunk', () => {
  it('retries a failure right after a ping and streams the retry to the same handle', async () => {
    const { client, createStream } = createMockStreamingClient([
      scripted([ping, new FakeApiError('overloaded', 503)]),
      scripted([ping, text('hel'), text('lo')]),
    ]);

    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 1 });
    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    expect(await collect(chunks)).toEqual([text('hel'), text('lo')]);
    await expect(finalResult).resolves.toBe('hello');
    expect(createStream).toHaveBeenCalledTimes(2);
  });

  it('falls back to the next target when every retry fails before content', async () => {
    const primary = createMockStreamingClient([scripted([ping, new FakeApiError('down', 503)])]);
    const fallback = createMockStreamingClient([scripted([text('from fallback')])]);
    const meta: { current?: CallMeta } = {};

    const llm = new VernLLM({
      client: primary.client,
      model: 'primary-model',
      maxRetries: 0,
      fallback: { client: fallback.client, model: 'fallback-model' },
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
      meta,
    });

    // Opened on the primary's ping, so meta first names the primary.
    expect(meta.current).toMatchObject({ provider: 'primary', usedFallback: false });

    expect(await collect(chunks)).toEqual([text('from fallback')]);
    await expect(finalResult).resolves.toBe('from fallback');
    expect(meta.current).toMatchObject({
      model: 'fallback-model',
      usedFallback: true,
      fallbackIndex: 0,
    });
  });

  it('hands back the stream on a ping, before any content, so thinking stays outside timeoutMs', async () => {
    vi.useFakeTimers();

    try {
      const { client } = createMockStreamingClient([
        scripted([ping, { waitMs: 500 }, ping, { waitMs: 500 }, text('done')]),
      ]);

      const llm = new VernLLM({
        client,
        model: 'm',
        timeoutMs: 100,
        chunkIdleTimeoutMs: 1_000,
        maxRetries: 0,
      });

      const handle = llm.call({ userContent: 'hi', jsonMode: false, stream: true });
      await vi.advanceTimersByTimeAsync(0);

      // Resolved on the ping alone, long before the content arrives.
      const { finalResult } = await handle;

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(finalResult).resolves.toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries when pings stop and the idle timeout fires before content', async () => {
    vi.useFakeTimers();

    try {
      const { client, createStream } = createMockStreamingClient([
        scripted([ping, { waitMs: 10_000 }, text('never')]),
        scripted([text('second')]),
      ]);

      const llm = new VernLLM({
        client,
        model: 'm',
        chunkIdleTimeoutMs: 200,
        maxRetries: 1,
        baseDelayMs: 1,
      });

      const handle = llm.call({ userContent: 'hi', jsonMode: false, stream: true });
      await vi.advanceTimersByTimeAsync(0);
      const { finalResult } = await handle;

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(finalResult).resolves.toBe('second');
      expect(createStream).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a stream that only ever pinged and then ended', async () => {
    const { client, createStream } = createMockStreamingClient([
      scripted([ping, ping]),
      scripted([text('ok')]),
    ]);

    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 1 });
    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });

    await expect(finalResult).resolves.toBe('ok');
    expect(createStream).toHaveBeenCalledTimes(2);
  });

  it('rejects with the last error once retries run out before content', async () => {
    const { client } = createMockStreamingClient([scripted([ping, new FakeApiError('down', 503)])]);

    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 1 });
    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    await expect(finalResult).rejects.toMatchObject({ type: 'api', status: 503 });
    await expect(collect(chunks)).rejects.toBeInstanceOf(LLMError);
  });

  it('does not retry a failure after content has reached the caller', async () => {
    const { client, createStream } = createMockStreamingClient([
      scripted([ping, text('partial'), new FakeApiError('down', 503)]),
      scripted([text('should not be used')]),
    ]);

    const llm = new VernLLM({ client, model: 'm', maxRetries: 2, baseDelayMs: 1 });
    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });

    await expect(finalResult).rejects.toMatchObject({ status: 503 });
    expect(createStream).toHaveBeenCalledTimes(1);
  });

  it('keeps a usage chunk that arrived before content and replays it in order', async () => {
    const usage: WireStreamChunk = {
      type: 'usage',
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    };
    const { client } = createMockStreamingClient([scripted([ping, usage, text('x')])]);

    const llm = new VernLLM({ client, model: 'm' });
    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    const seen = await collect(chunks);
    expect(seen.map((c) => c.type)).toEqual(['usage', 'text-delta']);
    await expect(finalResult).resolves.toBe('x');
  });

  it('counts a failure before content toward the breaker like any other attempt failure', async () => {
    const { client } = createMockStreamingClient([scripted([ping, new FakeApiError('down', 503)])]);

    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
    });

    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });
    await expect(finalResult).rejects.toMatchObject({ status: 503 });

    expect(llm.getCircuitStates()[0]?.state).toBe('open');
  });

  it('reacts to a rate limit hint that arrives between a ping and the first content', async () => {
    const hint: WireStreamChunk = { type: 'rate_limit_hint', hint: { remainingRequests: 1 } };
    const { client } = createMockStreamingClient([scripted([ping, hint, text('ok')])]);
    const reactToRateLimitHint = vi.fn();

    const llm = new VernLLM({
      client,
      model: 'm',
      rateLimit: {
        estimate: () => 1,
        acquire: async () => ({ release: () => {}, waitedMs: 0 }),
        signalRateLimit: () => {},
        reactToRateLimitHint,
      },
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    expect(await collect(chunks)).toEqual([text('ok')]);
    await expect(finalResult).resolves.toBe('ok');
    expect(reactToRateLimitHint).toHaveBeenCalledWith({ remainingRequests: 1 });
  });

  it('reports usage spent before a mid-stream failure once, and closes the replayed stream', async () => {
    const usage: WireStreamChunk = {
      type: 'usage',
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    };
    const onUsageFailure = vi.fn();
    const returned = vi.fn();

    const { client } = createMockStreamingClient([
      () => {
        const steps: Step[] = [ping, usage, text('partial'), new FakeApiError('down', 503)];
        let i = 0;
        return {
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<WireStreamChunk>> => {
              const step = steps[i++];
              if (step === undefined) return { done: true, value: undefined };
              if (step instanceof Error) throw step;
              return { done: false, value: step as WireStreamChunk };
            },
            return: async (): Promise<IteratorResult<WireStreamChunk>> => {
              returned();
              return { done: true, value: undefined };
            },
          }),
        };
      },
    ]);

    const llm = new VernLLM({ client, model: 'm', maxRetries: 0, onUsageFailure });
    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });

    await expect(finalResult).rejects.toMatchObject({ status: 503 });
    expect(onUsageFailure).toHaveBeenCalledOnce();
    expect(onUsageFailure).toHaveBeenCalledWith(
      expect.objectContaining({ totalTokens: 4 }),
      expect.any(LLMError),
    );
    expect(returned).toHaveBeenCalled();
  });

  it('reopens on a fallback with its own model, not the per call override', async () => {
    const primary = createMockStreamingClient([scripted([ping, new FakeApiError('down', 503)])]);
    const fallback = createMockStreamingClient([scripted([text('ok')])]);
    const meta: { current?: CallMeta } = {};

    const llm = new VernLLM({
      client: primary.client,
      model: 'primary-model',
      maxRetries: 0,
      fallback: { client: fallback.client, model: 'fallback-model' },
    });

    const { finalResult } = await llm.call({
      userContent: 'hi',
      model: 'override-model',
      jsonMode: false,
      stream: true,
      meta,
    });

    expect(meta.current?.model).toBe('override-model');
    await expect(finalResult).resolves.toBe('ok');
    expect(primary.calls[0]?.model).toBe('override-model');
    expect(fallback.calls[0]?.model).toBe('fallback-model');
    expect(meta.current?.model).toBe('fallback-model');
  });

  /** A bare iterator over `steps`, with `extra` merged in (a `return`, or none). */
  function bareStream(
    steps: Step[],
    extra: Partial<AsyncIterator<WireStreamChunk>> = {},
  ): () => AsyncIterable<WireStreamChunk> {
    return () => {
      let i = 0;
      return {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<WireStreamChunk>> => {
            const step = steps[i++];
            if (step === undefined) return { done: true, value: undefined };
            if (step instanceof Error) throw step;
            return { done: false, value: step as WireStreamChunk };
          },
          ...extra,
        }),
      };
    };
  }

  const usageChunk: WireStreamChunk = {
    type: 'usage',
    usage: { prompt_tokens: 2, completion_tokens: 0, total_tokens: 2 },
  };

  it('closes a replayed stream whose iterator has no return method', async () => {
    const onUsageFailure = vi.fn();
    const { client } = createMockStreamingClient([
      bareStream([ping, usageChunk, text('partial'), new FakeApiError('down', 503)]),
    ]);

    const llm = new VernLLM({ client, model: 'm', maxRetries: 0, onUsageFailure });
    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });

    // The failure after content closes the replay iterator, which has no inner return to call.
    await expect(finalResult).rejects.toMatchObject({ status: 503 });
    expect(onUsageFailure).toHaveBeenCalledOnce();
  });

  it('swallows a rejecting return() while closing a stream that failed before content', async () => {
    const { client } = createMockStreamingClient([
      bareStream([ping, new FakeApiError('down', 503)], {
        return: async () => {
          throw new Error('close failed');
        },
      }),
    ]);

    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });
    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });

    await expect(finalResult).rejects.toMatchObject({ status: 503 });
  });

  it('does not report held usage as a failure when the caller aborted before content', async () => {
    const controller = new AbortController();
    const onUsageFailure = vi.fn();
    let step = 0;

    const { client } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<WireStreamChunk>> => {
            step += 1;
            if (step === 1) return { done: false, value: ping };
            if (step === 2) return { done: false, value: usageChunk };
            // The caller aborts while the model is still thinking, and the
            // transport fails the way it does once its signal fires.
            controller.abort();
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
          },
        }),
      }),
    ]);

    const llm = new VernLLM({ client, model: 'm', maxRetries: 0, onUsageFailure });
    const { finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
      signal: controller.signal,
    });

    await expect(finalResult).rejects.toMatchObject({ type: 'aborted' });
    expect(onUsageFailure).not.toHaveBeenCalled();
  });
});
