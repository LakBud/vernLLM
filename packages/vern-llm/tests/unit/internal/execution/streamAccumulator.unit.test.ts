import { describe, it, expect, vi } from 'vitest';

import { LLMError, type StreamChunk, type WireStreamChunk } from '../../../../src/index.js';
import { buildStreamResult } from '../../../../src/internal/execution/streamAccumulator.js';

/**
 * A hand-built `AsyncIterator<WireStreamChunk>`, standing in for what an
 * adapter's `createStream(...)[Symbol.asyncIterator]()` would return.
 * `failAt`/`hangAt` let a test make a specific `.next()` call throw or
 * never settle, without needing a real transport.
 */
function scriptedIterator(
  chunks: WireStreamChunk[],
  options?: { failAt?: number; error?: unknown; hangAt?: number },
): AsyncIterator<WireStreamChunk> & { returnCalls: number } {
  let index = 0;
  const state = {
    returnCalls: 0,
    async next(): Promise<IteratorResult<WireStreamChunk>> {
      if (options?.hangAt !== undefined && index === options.hangAt) {
        return new Promise<IteratorResult<WireStreamChunk>>(() => {});
      }

      if (options?.failAt !== undefined && index === options.failAt) {
        throw options.error ?? new Error('transport error');
      }

      if (index >= chunks.length) {
        return { done: true, value: undefined };
      }

      return { done: false, value: chunks[index++]! };
    },
    async return(): Promise<IteratorResult<WireStreamChunk>> {
      state.returnCalls++;
      return { done: true, value: undefined };
    },
  };

  return state;
}

function testLogger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Default options, overridable per test. `finalize` just joins the accumulated pieces so assertions can inspect what the accumulator gathered. */
function baseOptions(overrides?: {
  onStreamSuccess?: (usage: unknown) => void;
  onStreamFailure?: (normalized: LLMError, usage: unknown) => void;
  finalize?: (textAcc: string, wireToolCalls: unknown, usage: unknown) => unknown;
  chunkIdleTimeoutMs?: number;
  logger?: ReturnType<typeof testLogger>;
}) {
  return {
    requestId: 'req-1',
    model: 'test-model',
    providerName: 'test-provider',
    isFallback: false,
    chunkIdleTimeoutMs: overrides?.chunkIdleTimeoutMs,
    streamController: new AbortController(),
    logger: overrides?.logger ?? testLogger(),
    onStreamSuccess: overrides?.onStreamSuccess ?? vi.fn(),
    onStreamFailure: overrides?.onStreamFailure ?? vi.fn(),
    finalize: overrides?.finalize ?? ((textAcc: string) => textAcc),
  };
}

async function drain(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

describe('buildStreamResult, chunk translation', () => {
  it('pushes text-delta chunks live and accumulates them into the string finalize receives', async () => {
    const iterator = scriptedIterator([{ type: 'text-delta', delta: 'world' }]);
    const first: IteratorResult<WireStreamChunk> = {
      done: false,
      value: { type: 'text-delta', delta: 'hello ' },
    };

    const { chunks, finalResult } = buildStreamResult(iterator, first, baseOptions());

    expect(await drain(chunks)).toEqual([
      { type: 'text-delta', delta: 'hello ' },
      { type: 'text-delta', delta: 'world' },
    ]);
    await expect(finalResult).resolves.toBe('hello world');
  });

  it('ignores ping chunks: no pushed StreamChunk, no accumulation', async () => {
    const iterator = scriptedIterator([{ type: 'ping' }, { type: 'text-delta', delta: 'ok' }]);
    const first: IteratorResult<WireStreamChunk> = { done: false, value: { type: 'ping' } };

    const { chunks, finalResult } = buildStreamResult(iterator, first, baseOptions());

    expect(await drain(chunks)).toEqual([{ type: 'text-delta', delta: 'ok' }]);
    await expect(finalResult).resolves.toBe('ok');
  });

  it('accumulates tool_call_delta chunks per index and sorts them by index before finalize', async () => {
    const iterator = scriptedIterator([
      { type: 'tool_call_delta', index: 1, id: 'call_1', name: 'second', argumentsDelta: '{}' },
      { type: 'tool_call_delta', index: 0, name: undefined, argumentsDelta: '"more"' },
    ]);
    const first: IteratorResult<WireStreamChunk> = {
      done: false,
      value: {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_0',
        name: 'first',
        argumentsDelta: '{"a":',
      },
    };

    let received: unknown;
    const { finalResult } = buildStreamResult(
      iterator,
      first,
      baseOptions({
        finalize: (_text, wireToolCalls) => ((received = wireToolCalls), wireToolCalls),
      }),
    );

    await finalResult;

    expect(received).toEqual([
      { id: 'call_0', type: 'function', function: { name: 'first', arguments: '{"a":"more"' } },
      { id: 'call_1', type: 'function', function: { name: 'second', arguments: '{}' } },
    ]);
  });

  it('translates a usage chunk into TokenUsage carrying requestId/model/providerName, pushes it live, and passes it to finalize', async () => {
    const iterator = scriptedIterator([
      { type: 'usage', usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
    ]);
    const first: IteratorResult<WireStreamChunk> = {
      done: false,
      value: { type: 'text-delta', delta: 'x' },
    };

    let finalizeUsage: unknown;
    const { chunks, finalResult } = buildStreamResult(
      iterator,
      first,
      baseOptions({ finalize: (text, _tc, usage) => ((finalizeUsage = usage), text) }),
    );

    const collected = await drain(chunks);
    await finalResult;

    const secondChunk = collected[1];

    expect(secondChunk).toEqual({
      type: 'usage',
      usage: {
        promptTokens: 3,
        completionTokens: 4,
        totalTokens: 7,
        requestId: 'req-1',
        model: 'test-model',
        provider: 'test-provider',
        usedFallback: false,
      },
    });
    expect(finalizeUsage).toEqual(secondChunk?.type === 'usage' ? secondChunk.usage : undefined);
  });
});

describe('buildStreamResult, success path', () => {
  it('calls onStreamSuccess exactly once, before finalize, with the last usage seen', async () => {
    const order: string[] = [];
    const onStreamSuccess = vi.fn(() => order.push('onStreamSuccess'));
    const iterator = scriptedIterator([
      { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]);
    const first: IteratorResult<WireStreamChunk> = {
      done: false,
      value: { type: 'text-delta', delta: 'a' },
    };

    const { finalResult } = buildStreamResult(
      iterator,
      first,
      baseOptions({
        onStreamSuccess,
        finalize: (text) => (order.push('finalize'), text),
      }),
    );

    await finalResult;

    expect(onStreamSuccess).toHaveBeenCalledOnce();
    expect(onStreamSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
    );
    expect(order).toEqual(['onStreamSuccess', 'finalize']);
  });

  it('resolves finalResult with whatever finalize returns', async () => {
    const iterator = scriptedIterator([]);
    const first: IteratorResult<WireStreamChunk> = { done: true, value: undefined };

    const { finalResult } = buildStreamResult(
      iterator,
      first,
      baseOptions({ finalize: () => ({ shaped: 'result' }) }),
    );

    await expect(finalResult).resolves.toEqual({ shaped: 'result' });
  });

  it('rejects finalResult, without a second onStreamFailure call, when finalize itself throws', async () => {
    const onStreamFailure = vi.fn();
    const iterator = scriptedIterator([]);
    const first: IteratorResult<WireStreamChunk> = { done: true, value: undefined };
    const finalizeError = new LLMError('bad json', 'parse');

    const { finalResult } = buildStreamResult(
      iterator,
      first,
      baseOptions({
        onStreamFailure,
        finalize: () => {
          throw finalizeError;
        },
      }),
    );

    await expect(finalResult).rejects.toBe(finalizeError);
    // finalize's caller (finalizeResponse) already normalizes/reports this
    // failure itself; the accumulator must not report it a second time.
    expect(onStreamFailure).not.toHaveBeenCalled();
  });
});

describe('buildStreamResult, transport failure path', () => {
  it('normalizes a transport error, calls onStreamFailure with any partial usage, and rejects finalResult with the normalized error', async () => {
    const iterator = scriptedIterator(
      [{ type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }],
      { failAt: 1 },
    );
    const first: IteratorResult<WireStreamChunk> = {
      done: false,
      value: { type: 'text-delta', delta: 'partial' },
    };

    const onStreamFailure = vi.fn();
    const { chunks, finalResult } = buildStreamResult(
      iterator,
      first,
      baseOptions({ onStreamFailure }),
    );

    await expect(drain(chunks)).rejects.toBeInstanceOf(LLMError);
    await expect(finalResult).rejects.toBeInstanceOf(LLMError);

    expect(onStreamFailure).toHaveBeenCalledOnce();
    const [normalized, usage] = onStreamFailure.mock.calls[0]!;
    expect(normalized).toBeInstanceOf(LLMError);
    expect(usage).toEqual(expect.objectContaining({ totalTokens: 1 }));
  });

  it('calls iterator.return() and aborts streamController on a transport failure, for best-effort cleanup', async () => {
    const iterator = scriptedIterator([], { failAt: 0 });
    const first: IteratorResult<WireStreamChunk> = {
      done: false,
      value: { type: 'text-delta', delta: 'x' },
    };
    const options = baseOptions();

    const { finalResult } = buildStreamResult(iterator, first, options);

    await expect(finalResult).rejects.toBeInstanceOf(LLMError);
    expect(iterator.returnCalls).toBe(1);
    expect(options.streamController.signal.aborted).toBe(true);
  });

  it('still normalizes and propagates the failure when iterator.return() itself throws', async () => {
    const iterator = scriptedIterator([], { failAt: 0 });
    iterator.return = async () => {
      throw new Error('cleanup also failed');
    };
    const first: IteratorResult<WireStreamChunk> = {
      done: false,
      value: { type: 'text-delta', delta: 'x' },
    };

    const { finalResult } = buildStreamResult(iterator, first, baseOptions());

    await expect(finalResult).rejects.toBeInstanceOf(LLMError);
  });

  it('reports type "aborted" instead of the raw transport error when the external signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const iterator = scriptedIterator([], { failAt: 0 });
    const first: IteratorResult<WireStreamChunk> = {
      done: false,
      value: { type: 'text-delta', delta: 'x' },
    };

    const onStreamFailure = vi.fn();
    const { finalResult } = buildStreamResult(iterator, first, {
      ...baseOptions({ onStreamFailure }),
      signal: controller.signal,
    });

    await expect(finalResult).rejects.toMatchObject({ type: 'aborted' });
    expect(onStreamFailure.mock.calls[0]![0]).toMatchObject({ type: 'aborted' });
  });

  it('fails with type "timeout" and aborts streamController when no chunk arrives within chunkIdleTimeoutMs', async () => {
    const iterator = scriptedIterator([{ type: 'text-delta', delta: 'more' }], { hangAt: 0 });
    const first: IteratorResult<WireStreamChunk> = {
      done: false,
      value: { type: 'text-delta', delta: 'first' },
    };

    const onStreamFailure = vi.fn();
    const options = baseOptions({ onStreamFailure, chunkIdleTimeoutMs: 20 });
    const { chunks, finalResult } = buildStreamResult(iterator, first, options);

    await expect(drain(chunks)).rejects.toMatchObject({ type: 'timeout' });
    await expect(finalResult).rejects.toMatchObject({ type: 'timeout' });

    expect(onStreamFailure).toHaveBeenCalledOnce();
    expect(onStreamFailure.mock.calls[0]![0]).toMatchObject({ type: 'timeout' });
    expect(options.streamController.signal.aborted).toBe(true);
  });
});

describe('buildStreamResult, chunks iterable semantics', () => {
  it('delivers a pushed chunk directly to an already-waiting subscriber instead of only buffering it', async () => {
    let releaseSecond!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    let calls = 0;
    const iterator: AsyncIterator<WireStreamChunk> = {
      async next() {
        calls++;

        if (calls === 1) {
          await gate;
          return { done: false, value: { type: 'text-delta', delta: 'late' } };
        }

        return { done: true, value: undefined };
      },
    };
    const first: IteratorResult<WireStreamChunk> = {
      done: false,
      value: { type: 'text-delta', delta: 'first' },
    };

    const { chunks } = buildStreamResult(iterator, first, baseOptions());
    const iter = chunks[Symbol.asyncIterator]();

    expect(await iter.next()).toEqual({
      done: false,
      value: { type: 'text-delta', delta: 'first' },
    });

    // Subscriber is now waiting on a chunk that hasn't arrived yet.
    const pendingNext = iter.next();
    releaseSecond();

    expect(await pendingNext).toEqual({
      done: false,
      value: { type: 'text-delta', delta: 'late' },
    });
  });

  it('buffers chunks produced ahead of a subscriber that has not started reading yet, then drains them in order', async () => {
    const iterator = scriptedIterator([
      { type: 'text-delta', delta: 'b' },
      { type: 'text-delta', delta: 'c' },
    ]);
    const first: IteratorResult<WireStreamChunk> = {
      done: false,
      value: { type: 'text-delta', delta: 'a' },
    };

    const { chunks, finalResult } = buildStreamResult(iterator, first, baseOptions());

    // Nobody reads `chunks` until the whole stream has already finished.
    await finalResult;

    expect(await drain(chunks)).toEqual([
      { type: 'text-delta', delta: 'a' },
      { type: 'text-delta', delta: 'b' },
      { type: 'text-delta', delta: 'c' },
    ]);
  });

  it('resolves done:true for a subscriber that only starts reading after the stream already finished successfully', async () => {
    const iterator = scriptedIterator([]);
    const first: IteratorResult<WireStreamChunk> = { done: true, value: undefined };

    const { chunks, finalResult } = buildStreamResult(iterator, first, baseOptions());
    await finalResult;

    const iter = chunks[Symbol.asyncIterator]();
    expect(await iter.next()).toEqual({ done: true, value: undefined });
  });

  it('rejects with the stream error, after any already-buffered chunks, for a subscriber that only starts reading after the stream already failed', async () => {
    const iterator = scriptedIterator([], { failAt: 0 });
    const first: IteratorResult<WireStreamChunk> = {
      done: false,
      value: { type: 'text-delta', delta: 'x' },
    };

    const { chunks, finalResult } = buildStreamResult(iterator, first, baseOptions());
    await finalResult.catch(() => {});

    // The 'x' chunk pushed before the failure is still unread and sitting
    // in the buffer; `drain` should yield it before the stream error
    // surfaces on the following `.next()` call.
    await expect(drain(chunks)).rejects.toBeInstanceOf(LLMError);
  });
});

describe('buildStreamResult, unread-backlog eviction', () => {
  it('trims the buffer back to the cap and logs the eviction exactly once, when nobody reads chunks for a large stream', async () => {
    const MAX_BUFFERED_CHUNKS = 10_000;
    // One chunk past the 2x-cap eviction threshold, the minimal case that
    // triggers exactly one eviction: buffered.length hits MAX*2 + 1,
    // splice(0, 1) trims it back down to exactly the cap.
    const overflow = Array.from({ length: MAX_BUFFERED_CHUNKS * 2 + 1 }, (_, i) => ({
      type: 'text-delta' as const,
      delta: String(i),
    }));

    const iterator = scriptedIterator(overflow.slice(1));
    const first: IteratorResult<WireStreamChunk> = { done: false, value: overflow[0]! };
    const logger = testLogger();

    const { chunks, finalResult } = buildStreamResult(iterator, first, baseOptions({ logger }));

    await finalResult;

    const collected = await drain(chunks);
    expect(collected.length).toBe(MAX_BUFFERED_CHUNKS);
    // The oldest MAX_BUFFERED_CHUNKS + 1 pushes were evicted, so the
    // surviving oldest entry is the one right after that cut.
    expect(collected[0]).toEqual({ type: 'text-delta', delta: String(MAX_BUFFERED_CHUNKS + 1) });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('exceeded cap'));
  });
});
