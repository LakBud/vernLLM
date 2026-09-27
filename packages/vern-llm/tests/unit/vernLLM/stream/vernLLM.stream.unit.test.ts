import { describe, expect, it, vi } from 'vitest';

import { LLMError, type WireStreamChunk } from '../../../../src/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { createMockStreamingClient, drain, scriptedIteratorWithReturn } from '../../../helpers.js';

const weatherTool = {
  name: 'get_weather',
  description: 'Gets the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

describe('VernLLM.call, stream: true', () => {
  it('yields live text-delta chunks and resolves finalResult to the same shape a non-streaming call would return', async () => {
    const { client } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'Hello, ' },
        { type: 'text-delta', delta: 'world!' },
        { type: 'usage', usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
      ],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    const collected = await drain(chunks);

    expect(collected).toEqual([
      { type: 'text-delta', delta: 'Hello, ' },
      { type: 'text-delta', delta: 'world!' },
      {
        type: 'usage',
        usage: expect.objectContaining({ promptTokens: 3, completionTokens: 4, totalTokens: 7 }),
      },
    ]);

    await expect(finalResult).resolves.toBe('Hello, world!');
  });

  it('accumulates tool_call_delta chunks into the same validated ToolCall[] shape a non-streaming call would return', async () => {
    const { client } = createMockStreamingClient([
      [
        {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_1',
          name: 'get_weather',
          argumentsDelta: '{"ci',
        },
        { type: 'tool_call_delta', index: 0, argumentsDelta: 'ty":"Denver"}' },
      ],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const { chunks, finalResult } = await llm.call({
      userContent: 'what is the weather in Denver?',
      tools: [weatherTool],
      stream: true,
    });

    await drain(chunks);

    await expect(finalResult).resolves.toEqual({
      type: 'tool_calls',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Denver' } }],
    });
  });

  it('validates the fully-buffered JSON once at stream end, same as jsonMode/schema on a non-streaming call', async () => {
    const { client } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: '{"answer":' },
        { type: 'text-delta', delta: '"42"}' },
      ],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const { finalResult } = await llm.call<{ answer: string }>({
      userContent: 'question',
      jsonMode: true,
      stream: true,
    });

    await expect(finalResult).resolves.toEqual({ answer: '42' });
  });

  it('rejects finalResult with a normalized LLMError and throws through the chunks iterator on a mid-stream error, without touching onUsage', async () => {
    const onUsage = vi.fn();
    const { client } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<{ type: 'text-delta'; delta: string }>> {
              if (step === 0) {
                step++;
                return { done: false, value: { type: 'text-delta', delta: 'partial' } };
              }
              throw new Error('connection dropped');
            },
          };
        },
      }),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', onUsage });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    await expect(drain(chunks)).rejects.toBeInstanceOf(LLMError);
    await expect(finalResult).rejects.toBeInstanceOf(LLMError);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('cleans up the iterator (calls return()) after a mid-stream processing failure', async () => {
    const onReturn = vi.fn();
    const { client } = createMockStreamingClient([
      scriptedIteratorWithReturn(
        [{ type: 'text-delta', delta: 'partial' }],
        new Error('connection dropped'),
        onReturn,
      ),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    await expect(drain(chunks)).rejects.toBeInstanceOf(LLMError);
    await expect(finalResult).rejects.toBeInstanceOf(LLMError);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejecting return() during mid-stream cleanup, reporting the original error', async () => {
    const { client } = createMockStreamingClient([
      scriptedIteratorWithReturn(
        [{ type: 'text-delta', delta: 'partial' }],
        new Error('connection dropped'),
        () => {
          throw new Error('cleanup also failed');
        },
      ),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    // The original stream error is what's reported, not the cleanup
    // failure. Cleanup failing during error handling shouldn't mask why
    // the stream actually failed.
    await expect(drain(chunks)).rejects.toMatchObject({ message: 'LLM request failed' });
    await expect(finalResult).rejects.toMatchObject({ message: 'LLM request failed' });
  });

  it('throws LLMError(invalid_params) immediately when the client has no createStream', async () => {
    const llm = new VernLLM({
      client: { chat: { completions: { create: vi.fn() } } },
      model: 'test-model',
    });

    await expect(llm.call({ userContent: 'hi', stream: true })).rejects.toMatchObject({
      type: 'invalid_params',
      code: 'unsupported_capability',
      issues: { capability: 'createStream' },
    });
  });

  it('retries a connection-open failure and rejects after retries are exhausted', async () => {
    const { client, createStream } = createMockStreamingClient([
      new Error('connect failed'),
      new Error('connect failed again'),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 1, baseDelayMs: 0 });

    await expect(
      llm.call({ userContent: 'hi', jsonMode: false, stream: true }),
    ).rejects.toBeInstanceOf(LLMError);
    expect(createStream).toHaveBeenCalledTimes(2);
  });

  it('records a circuit-breaker failure after retries are exhausted on connection-open failures', async () => {
    const { client } = createMockStreamingClient([new Error('connect failed')]);
    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      circuitBreaker: { threshold: 1 },
    });

    await expect(llm.call({ userContent: 'hi', jsonMode: false, stream: true })).rejects.toThrow();
    expect(llm.getCircuitState()).toBe('open');
  });

  it('does not record a circuit-breaker failure for a mid-stream (generation-time) error', async () => {
    const { client } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<{ type: 'text-delta'; delta: string }>> {
              if (step === 0) {
                step++;
                return { done: false, value: { type: 'text-delta', delta: 'partial' } };
              }
              throw new Error('dropped');
            },
          };
        },
      }),
    ]);
    const llm = new VernLLM({
      client,
      model: 'test-model',
      circuitBreaker: { threshold: 1 },
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    await expect(drain(chunks)).rejects.toBeInstanceOf(LLMError);
    await expect(finalResult).rejects.toBeInstanceOf(LLMError);
    expect(llm.getCircuitState()).toBe('closed');
  });

  it('reserves usage before opening the stream and refunds it when the stream never opens', async () => {
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockResolvedValue(undefined);
    const { client } = createMockStreamingClient([new Error('connect failed')]);
    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 0 });

    await expect(
      llm.call({
        userContent: 'hi',
        jsonMode: false,
        stream: true,
        reserveUsage,
        refundUsage,
      }),
    ).rejects.toBeInstanceOf(LLMError);

    expect(reserveUsage).toHaveBeenCalledTimes(1);
    expect(refundUsage).toHaveBeenCalledTimes(1);
  });

  it('logs, instead of throwing, when refundUsage itself throws after a streaming call fails to open', async () => {
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundError = new Error('refund boom');
    const refundUsage = vi.fn(async () => {
      throw refundError;
    });
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { client } = createMockStreamingClient([new Error('connect failed')]);
    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 0, logger });

    await expect(
      llm.call({
        userContent: 'hi',
        jsonMode: false,
        stream: true,
        reserveUsage,
        refundUsage,
      }),
    ).rejects.toBeInstanceOf(LLMError); // the original connect failure still propagates

    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] refundUsage failed after stream-open failure',
      { message: 'refund boom', stack: refundError.stack },
    );
  });

  it('reserves usage up front but defers refund until finalResult settles for a mid-stream failure', async () => {
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockResolvedValue(undefined);
    const { client } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<WireStreamChunk>> {
              if (step === 0) {
                step++;
                return { done: false, value: { type: 'text-delta', delta: 'first' } };
              }

              // A real macrotask delay (not just a microtask hop), so the
              // failure is guaranteed to land strictly after `call()` has
              // already returned `{ chunks, finalResult }`. Proving
              // refund really is deferred onto finalResult settling, not
              // just implicitly fast enough to look that way.
              await new Promise((resolve) => setTimeout(resolve, 15));
              throw new Error('dropped mid-stream');
            },
          };
        },
      }),
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
      reserveUsage,
      refundUsage,
    });

    // Reserved by the time call() returns, refund not yet issued.
    // That's deferred onto finalResult settling.
    expect(reserveUsage).toHaveBeenCalledTimes(1);
    expect(refundUsage).not.toHaveBeenCalled();

    await expect(drain(chunks)).rejects.toBeInstanceOf(LLMError);
    await expect(finalResult).rejects.toBeInstanceOf(LLMError);
    expect(refundUsage).toHaveBeenCalledTimes(1);
  });

  it('does not refund usage on a successful stream', async () => {
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockResolvedValue(undefined);
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'hi there' }]]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
      reserveUsage,
      refundUsage,
    });

    await drain(chunks);
    await expect(finalResult).resolves.toBe('hi there');
    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('invokes onUsage with the accumulated TokenUsage for a successful stream', async () => {
    const onUsage = vi.fn();
    const { client } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'hi there' },
        { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
      ],
    ]);
    const llm = new VernLLM({ client, model: 'test-model', onUsage });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    await drain(chunks);
    await expect(finalResult).resolves.toBe('hi there');

    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ promptTokens: 5, completionTokens: 3, totalTokens: 8 }),
    );
  });

  it('invokes onUsageFailure (not onUsage) when a usage chunk arrives before a mid-stream failure', async () => {
    const onUsage = vi.fn();
    const onUsageFailure = vi.fn();
    const { client } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<WireStreamChunk>> {
              if (step === 0) {
                step++;
                return {
                  done: false,
                  value: {
                    type: 'usage',
                    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
                  },
                };
              }
              throw new Error('connection dropped');
            },
          };
        },
      }),
    ]);
    // One attempt: a failure before content is retried, and each retry
    // would report its own usage failure.
    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      onUsage,
      onUsageFailure,
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    await expect(drain(chunks)).rejects.toBeInstanceOf(LLMError);
    await expect(finalResult).rejects.toBeInstanceOf(LLMError);

    expect(onUsage).not.toHaveBeenCalled();
    expect(onUsageFailure).toHaveBeenCalledTimes(1);
    expect(onUsageFailure).toHaveBeenCalledWith(
      expect.objectContaining({ promptTokens: 5, completionTokens: 3, totalTokens: 8 }),
      expect.any(LLMError),
    );
  });

  it("rejects finalResult with LLMError('Empty LLM response', 'api') for a stream that yields zero chunks", async () => {
    const { client } = createMockStreamingClient([[]]);
    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 0 });

    await expect(
      llm.call({ userContent: 'hi', jsonMode: false, stream: true }),
    ).rejects.toMatchObject({ type: 'api', message: 'Empty LLM response' });
  });

  it('bounds time-to-first-chunk with withTimeout, throwing LLMError(timeout) when the stream never opens in time', async () => {
    // Built directly (not via the helper) so the mock can capture the
    // abort signal `createStream` receives and actually honor it. A real
    // adapter's `createStream` does the same internally (e.g. via
    // `fetch`), which is what lets `withTimeout`'s internal
    // AbortController actually interrupt a hung first-chunk wait.
    const client = {
      chat: {
        completions: {
          create: async () => {
            throw new Error('not scripted');
          },
          createStream: (_params: unknown, options: { signal: AbortSignal }) => ({
            [Symbol.asyncIterator]() {
              return {
                next(): Promise<IteratorResult<WireStreamChunk>> {
                  return new Promise((_resolve, reject) => {
                    options.signal.addEventListener(
                      'abort',
                      () => {
                        reject(new DOMException('The operation was aborted', 'AbortError'));
                      },
                      { once: true },
                    );
                  });
                },
              };
            },
          }),
        },
      },
    };
    const llm = new VernLLM({ client, model: 'test-model', timeoutMs: 20, maxRetries: 0 });

    await expect(
      llm.call({ userContent: 'hi', jsonMode: false, stream: true }),
    ).rejects.toMatchObject({ type: 'timeout' });
  });

  it('rejects the call promise itself with code deadline_exceeded when deadlineMs elapses before the stream opens', async () => {
    // Same construction as the withTimeout test above: the mock captures
    // and honors the abort signal `createStream` receives, mirroring how
    // a real adapter's `createStream` lets an AbortController actually
    // interrupt a hung stream-open.
    const client = {
      chat: {
        completions: {
          create: async () => {
            throw new Error('not scripted');
          },
          createStream: (_params: unknown, options: { signal: AbortSignal }) => ({
            [Symbol.asyncIterator]() {
              return {
                next(): Promise<IteratorResult<WireStreamChunk>> {
                  return new Promise((_resolve, reject) => {
                    options.signal.addEventListener(
                      'abort',
                      () => {
                        reject(new DOMException('The operation was aborted', 'AbortError'));
                      },
                      { once: true },
                    );
                  });
                },
              };
            },
          }),
        },
      },
    };
    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 0 });

    await expect(
      llm.call({ userContent: 'hi', jsonMode: false, stream: true, deadlineMs: 10 }),
    ).rejects.toMatchObject({ type: 'aborted', code: 'deadline_exceeded' });
  });

  it('does not bound total stream duration once the first chunk has arrived', async () => {
    const { client } = createMockStreamingClient([
      () => ({
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next(): Promise<IteratorResult<WireStreamChunk>> {
              if (step === 0) {
                step++;
                return { done: false, value: { type: 'text-delta', delta: 'first' } };
              }
              if (step === 1) {
                step++;
                // Long pause well past timeoutMs. Should NOT time out,
                // since the timeout only bounds time-to-first-chunk.
                await new Promise((resolve) => setTimeout(resolve, 30));
                return { done: false, value: { type: 'text-delta', delta: ' second' } };
              }
              return { done: true, value: undefined };
            },
          };
        },
      }),
    ]);
    const llm = new VernLLM({ client, model: 'test-model', timeoutMs: 10 });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    await drain(chunks);
    await expect(finalResult).resolves.toBe('first second');
  });

  it('finalResult resolves even when the caller never reads chunks', async () => {
    const { client } = createMockStreamingClient([
      [{ type: 'text-delta', delta: 'no reader needed' }],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });

    await expect(finalResult).resolves.toBe('no reader needed');
  });

  it('bounds the unread chunk backlog for a large stream nobody ever reads, without affecting finalResult', async () => {
    // Well past 2x the eviction threshold, exercises the cap that keeps
    // an entirely-ignored `chunks` from holding the whole stream's output
    // in memory for its duration.
    const chunkCount = 25_000;
    const wireChunks: WireStreamChunk[] = Array.from({ length: chunkCount }, (_, i) => ({
      type: 'text-delta',
      delta: `${i} `,
    }));
    const { client } = createMockStreamingClient([wireChunks]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });

    // finalResult accumulates from the wire chunks directly, not from the
    // (capped) chunks buffer, so it's unaffected by the cap dropping old
    // backlog entries. finalizeResponse trims the accumulated text, hence
    // .trim() here too.
    const expected = Array.from({ length: chunkCount }, (_, i) => `${i} `)
      .join('')
      .trim();
    await expect(finalResult).resolves.toBe(expected);
  });

  it('drops the oldest backlog entries once the unread chunk cap is exceeded, keeping only the most recent ones', async () => {
    const chunkCount = 25_000;
    const wireChunks: WireStreamChunk[] = Array.from({ length: chunkCount }, (_, i) => ({
      type: 'text-delta',
      delta: `${i} `,
    }));
    const { client } = createMockStreamingClient([wireChunks]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    // finalResult already settled from the eagerly-running pump by the
    // time `call()` resolves for this fast mock stream, so `chunks` is
    // read here strictly *after* the whole backlog was built up unread,
    // exactly the pathological case the cap targets.
    await finalResult;

    const collected = await drain(chunks);

    // Bounded, and short of the full 25,000 chunks the stream actually
    // produced, the oldest entries were dropped once the backlog grew
    // past the (batched) eviction threshold.
    expect(collected.length).toBeLessThan(chunkCount);
    expect(collected.length).toBeGreaterThan(0);
    // Pins the actual guarantee, not just "it shrank": the backlog never
    // grows past 2x the cap before being trimmed back down.
    expect(collected.length).toBeLessThanOrEqual(20_000);

    // What's left is a contiguous tail: the oldest surviving entry's
    // index is exactly (chunkCount: collected.length), confirming
    // eviction removed from the front, not scattered or from the back.
    const firstSurvivingDelta = (collected[0] as { type: 'text-delta'; delta: string }).delta;
    const expectedFirstIndex = chunkCount - collected.length;
    expect(firstSurvivingDelta).toBe(`${expectedFirstIndex} `);
  });

  it('evicts the unread backlog in amortized O(1) per chunk, not O(cap) per chunk', async () => {
    // Regression test for a real perf cliff: naive per-push `shift()`
    // eviction is O(current length) *every* push once the cap is
    // reached, so a large ignored stream could take seconds (or worse)
    // just running the pump, independent of any real work. Batched
    // eviction (grow to 2x cap, trim in one splice) amortizes that cost.
    // 200,000 chunks is far more than any test above exercises, and
    // asserts the pump completes quickly rather than stalling.
    const chunkCount = 200_000;
    const wireChunks: WireStreamChunk[] = Array.from({ length: chunkCount }, () => ({
      type: 'text-delta',
      delta: 'x',
    }));
    const { client } = createMockStreamingClient([wireChunks]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const start = Date.now();
    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });
    await finalResult;
    const elapsedMs = Date.now() - start;

    // Generous ceiling, the point isn't precise timing, it's ruling out
    // the multi-second-plus stalls the naive per-push shift() showed at
    // nearby array sizes in isolated benchmarking.
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('logs (at warn level) when the unread chunk backlog is evicted past its cap', async () => {
    const wireChunks: WireStreamChunk[] = Array.from({ length: 25_000 }, () => ({
      type: 'text-delta',
      delta: 'x',
    }));
    const { client } = createMockStreamingClient([wireChunks]);
    const warn = vi.fn();
    const logger = { debug: vi.fn(), warn, error: vi.fn() };
    const llm = new VernLLM({ client, model: 'test-model', logger });

    // `chunks` deliberately never read: this is exactly the pathological
    // case eviction exists for.
    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });
    await finalResult;

    expect(warn).toHaveBeenCalled();
    const message = warn.mock.calls.map(([msg]) => String(msg)).join('\n');
    expect(message).toContain('evicting');
  });

  it('logs the eviction warning exactly once per stream, even when the backlog crosses the cap many times over', async () => {
    // MAX_BUFFERED_CHUNKS is 10,000 and eviction logs once every time
    // buffered.length crosses 2x that. A stream this large would cross
    // that line many times over if each crossing logged separately, this
    // asserts a single log line regardless of how far past the cap an
    // ignored stream grows.
    const wireChunks: WireStreamChunk[] = Array.from({ length: 150_000 }, () => ({
      type: 'text-delta',
      delta: 'x',
    }));
    const { client } = createMockStreamingClient([wireChunks]);
    const warn = vi.fn();
    const logger = { debug: vi.fn(), warn, error: vi.fn() };
    const llm = new VernLLM({ client, model: 'test-model', logger });

    const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });
    await finalResult;

    const evictionLogs = warn.mock.calls.filter(([msg]) => String(msg).includes('evicting'));
    expect(evictionLogs).toHaveLength(1);
  });
});
