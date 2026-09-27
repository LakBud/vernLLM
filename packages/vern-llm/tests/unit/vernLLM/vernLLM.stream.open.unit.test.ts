import { describe, it, expect, vi } from 'vitest';

import { LLMError, type WireStreamChunk } from '../../../src/index.js';
import { VernLLM } from '../../../src/vernLLM.js';
import { createMockStreamingClient, drain } from '../../helpers.js';

function hintThenThrow(error: Error): () => AsyncIterable<WireStreamChunk> {
  return () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'rate_limit_hint', hint: { remainingRequests: 3 } };
      throw error;
    },
  });
}

function serverError(): LLMError {
  return new LLMError('Service unavailable', 'api', { status: 503 });
}

function limiter() {
  return {
    estimate: () => 0,
    acquire: vi.fn().mockResolvedValue({ release: () => {}, waitedMs: 0 }),
    signalRateLimit: vi.fn(),
    reactToRateLimitHint: vi.fn(),
  };
}

describe('VernLLM.call, stream open with a leading rate-limit hint', () => {
  it('retries a failure on the first real chunk after a hint', async () => {
    const { client, createStream } = createMockStreamingClient([
      hintThenThrow(serverError()),
      hintThenThrow(serverError()),
      [{ type: 'text-delta', delta: 'ok' }],
    ]);
    const rateLimit = limiter();
    const llm = new VernLLM({ client, model: 'm', maxRetries: 3, baseDelayMs: 0, rateLimit });

    const result = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });
    await drain(result.chunks);

    await expect(result.finalResult).resolves.toBe('ok');
    expect(createStream).toHaveBeenCalledTimes(3);
    expect(rateLimit.reactToRateLimitHint).toHaveBeenCalledTimes(2);
  });

  it('falls back when every primary attempt fails after a hint', async () => {
    const primary = createMockStreamingClient([hintThenThrow(serverError())]);
    const fallback = createMockStreamingClient([[{ type: 'text-delta', delta: 'fb' }]]);
    const llm = new VernLLM({
      client: primary.client,
      model: 'm',
      maxRetries: 1,
      baseDelayMs: 0,
      fallback: { client: fallback.client, model: 'f' },
    });

    const result = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });
    await drain(result.chunks);

    await expect(result.finalResult).resolves.toBe('fb');
    expect(primary.createStream).toHaveBeenCalledTimes(2);
  });

  it('applies a hint that arrives after the stream opened', async () => {
    const hint = { remainingRequests: 2 };
    const { client } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'a' },
        { type: 'rate_limit_hint', hint },
        { type: 'text-delta', delta: 'b' },
      ],
    ]);
    const rateLimit = limiter();
    const llm = new VernLLM({ client, model: 'm', rateLimit });

    const result = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });
    await drain(result.chunks);

    await expect(result.finalResult).resolves.toBe('ab');
    expect(rateLimit.reactToRateLimitHint).toHaveBeenCalledExactlyOnceWith(hint);
  });

  it('treats a stream of only hints as an empty response', async () => {
    const { client } = createMockStreamingClient([
      [{ type: 'rate_limit_hint', hint: { remainingRequests: 1 } }],
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    await expect(llm.call({ userContent: 'hi', jsonMode: false, stream: true })).rejects.toThrow(
      'Empty LLM response',
    );
  });
});

describe('VernLLM.call, stream early exit', () => {
  it('leaves finalResult resolved when the stream already finished before the break', async () => {
    const { client } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'a' },
        { type: 'text-delta', delta: 'b' },
        { type: 'text-delta', delta: 'c' },
      ],
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    const result = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });

    await result.finalResult;
    for await (const _ of result.chunks) break;

    await expect(result.finalResult).resolves.toBe('abc');
  });

  /** A stream that yields `a`, then waits on `gate` before yielding `b`, recording the signal it was opened with. */
  function gatedStream(options: { ignoreAbort?: boolean } = {}) {
    let openRelease!: () => void;
    const gate = new Promise<void>((resolve) => {
      openRelease = resolve;
    });
    const signals: AbortSignal[] = [];

    const { client, createStream } = createMockStreamingClient([[]]);
    createStream.mockImplementation((_params, opts) => {
      signals.push(opts.signal);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', delta: 'a' } as WireStreamChunk;
          await (options.ignoreAbort
            ? gate
            : Promise.race([
                gate,
                new Promise<void>((_, reject) =>
                  opts.signal.addEventListener('abort', () => reject(new Error('aborted')), {
                    once: true,
                  }),
                ),
              ]));
          yield { type: 'text-delta', delta: 'b' } as WireStreamChunk;
        },
      };
    });

    return { client, createStream, signals, release: () => openRelease() };
  }

  it('cancels the provider stream on a break, and finalResult rejects as aborted', async () => {
    const { client, signals } = gatedStream();
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    const result = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });
    for await (const _ of result.chunks) break;

    await expect(result.finalResult).rejects.toMatchObject({ type: 'aborted' });
    expect(signals[0]!.aborted).toBe(true);
  });

  it('rejects as aborted even when the adapter ignores the abort and keeps yielding', async () => {
    const { client, release } = gatedStream({ ignoreAbort: true });
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    const result = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });
    for await (const _ of result.chunks) break;
    release();

    await expect(result.finalResult).rejects.toMatchObject({ type: 'aborted' });
  });

  it('cancels when the loop body throws, same as a break', async () => {
    const { client, signals } = gatedStream();
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    const result = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });
    await expect(
      (async () => {
        for await (const _ of result.chunks) throw new Error('consumer failed');
      })(),
    ).rejects.toThrow('consumer failed');

    await expect(result.finalResult).rejects.toMatchObject({ type: 'aborted' });
    expect(signals[0]!.aborted).toBe(true);
  });

  it('cancels on a break when the caller also passed its own signal, without aborting that signal', async () => {
    const { client, signals } = gatedStream();
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });
    const caller = new AbortController();

    const result = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
      signal: caller.signal,
    });
    for await (const _ of result.chunks) break;

    await expect(result.finalResult).rejects.toMatchObject({ type: 'aborted' });
    expect(signals[0]!.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
  });

  it('still cancels on the caller signal alone, with no break', async () => {
    const { client, signals } = gatedStream();
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });
    const caller = new AbortController();

    const result = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
      signal: caller.signal,
    });
    caller.abort();

    await expect(result.finalResult).rejects.toMatchObject({ type: 'aborted' });
    expect(signals[0]!.aborted).toBe(true);
  });

  it('frees the concurrency slot after a break, so a queued call can proceed', async () => {
    const { client, createStream } = gatedStream();
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      rateLimit: { maxConcurrent: 1, maxQueueMs: 1_000 },
    });

    const first = await llm.call({ userContent: 'one', jsonMode: false, stream: true });
    const second = llm.call({ userContent: 'two', jsonMode: false, stream: true });

    for await (const _ of first.chunks) break;
    await expect(first.finalResult).rejects.toMatchObject({ type: 'aborted' });

    const opened = await second;
    expect(createStream).toHaveBeenCalledTimes(2);
    for await (const _ of opened.chunks) break;
    await expect(opened.finalResult).rejects.toMatchObject({ type: 'aborted' });
  });
  it('lets a second loop read the chunks after a break', async () => {
    const { client } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'a' },
        { type: 'text-delta', delta: 'b' },
        { type: 'text-delta', delta: 'c' },
      ],
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    const result = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });
    await result.finalResult;

    for await (const _ of result.chunks) break;
    const rest: string[] = [];
    for await (const chunk of result.chunks) {
      if (chunk.type === 'text-delta') rest.push(chunk.delta);
    }

    expect(rest).toEqual(['b', 'c']);
  });
});
