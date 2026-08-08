import { describe, it, expect, vi } from 'vitest';

import { LLMError, type StreamChunk } from '../../src/index.js';
import { VernLLM } from '../../src/vernLLM.js';
import { createMockStreamingClient } from '../helpers.js';

const weatherTool = {
  name: 'get_weather',
  description: 'Gets the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

async function drain(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

describe('VernLLM.cachedCall, stream: true', () => {
  it('miss: relays live chunks and caches the settled finalResult value', async () => {
    const { client, createStream } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'Hello, ' },
        { type: 'text-delta', delta: 'world!' },
      ],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const { chunks, finalResult } = await llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: false, stream: true },
    });

    expect(await drain(chunks)).toEqual([
      { type: 'text-delta', delta: 'Hello, ' },
      { type: 'text-delta', delta: 'world!' },
    ]);
    await expect(finalResult).resolves.toBe('Hello, world!');
    expect(createStream).toHaveBeenCalledTimes(1);
  });

  it('hit: replays a one-shot chunks synthesized from the cached value, resolves finalResult instantly, and never opens a new stream', async () => {
    const { client, createStream } = createMockStreamingClient([
      [{ type: 'text-delta', delta: 'fresh' }],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const first = await llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: false, stream: true },
    });
    await drain(first.chunks);
    await first.finalResult;

    const second = await llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: false, stream: true },
    });

    expect(await drain(second.chunks)).toEqual([{ type: 'text-delta', delta: 'fresh' }]);
    await expect(second.finalResult).resolves.toBe('fresh');
    expect(createStream).toHaveBeenCalledTimes(1);
  });

  it("hit: replays a JSON.stringify'd text-delta when jsonMode produced a parsed (non-string) value", async () => {
    const { client } = createMockStreamingClient([
      [{ type: 'text-delta', delta: '{"answer":"42"}' }],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const first = await llm.cachedCall<{ answer: string }>({
      cacheKey: 'json-key',
      ttl: 60,
      call: { userContent: 'q', jsonMode: true, stream: true },
    });
    await drain(first.chunks);
    await first.finalResult;

    const second = await llm.cachedCall<{ answer: string }>({
      cacheKey: 'json-key',
      ttl: 60,
      call: { userContent: 'q', jsonMode: true, stream: true },
    });

    expect(await drain(second.chunks)).toEqual([{ type: 'text-delta', delta: '{"answer":"42"}' }]);
    await expect(second.finalResult).resolves.toEqual({ answer: '42' });
  });

  it('tools + streaming + caching: miss accumulates live tool_call_delta chunks into a validated result, and the cache stores the full CallWithToolsResult', async () => {
    const { client, createStream } = createMockStreamingClient([
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

    const { chunks, finalResult } = await llm.cachedCall({
      cacheKey: 'tool-key',
      ttl: 60,
      call: {
        userContent: 'weather in Denver?',
        tools: [weatherTool],
        stream: true,
      },
    });

    await drain(chunks);

    await expect(finalResult).resolves.toEqual({
      type: 'tool_calls',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Denver' } }],
    });
    expect(createStream).toHaveBeenCalledTimes(1);
  });

  it('tools + streaming + caching: hit replays one tool_call_delta per cached tool call, with the full accumulated arguments in a single delta', async () => {
    const { client, createStream } = createMockStreamingClient([
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

    const first = await llm.cachedCall({
      cacheKey: 'tool-key-2',
      ttl: 60,
      call: { userContent: 'weather?', tools: [weatherTool], stream: true },
    });
    await drain(first.chunks);
    await first.finalResult;

    const second = await llm.cachedCall({
      cacheKey: 'tool-key-2',
      ttl: 60,
      call: { userContent: 'weather?', tools: [weatherTool], stream: true },
    });

    expect(await drain(second.chunks)).toEqual([
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_1',
        name: 'get_weather',
        argsDelta: '{"city":"Denver"}',
        complete: true,
      },
    ]);
    await expect(second.finalResult).resolves.toEqual({
      type: 'tool_calls',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Denver' } }],
    });
    expect(createStream).toHaveBeenCalledTimes(1);
  });

  it('replays multiple cached tool calls as one tool_call_delta each, indexed in order', async () => {
    const { client } = createMockStreamingClient([
      [
        {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_1',
          name: 'get_weather',
          argumentsDelta: '{"city":"NYC"}',
        },
        {
          type: 'tool_call_delta',
          index: 1,
          id: 'call_2',
          name: 'get_time',
          argumentsDelta: '{"tz":"EST"}',
        },
      ],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const first = await llm.cachedCall({
      cacheKey: 'multi-tool-key',
      ttl: 60,
      call: {
        userContent: 'weather and time in NYC?',
        tools: [
          weatherTool,
          { name: 'get_time', description: 'Gets the time', parameters: { type: 'object' } },
        ],
        stream: true,
      },
    });
    await drain(first.chunks);
    await first.finalResult;

    const second = await llm.cachedCall({
      cacheKey: 'multi-tool-key',
      ttl: 60,
      call: {
        userContent: 'weather and time in NYC?',
        tools: [
          weatherTool,
          { name: 'get_time', description: 'Gets the time', parameters: { type: 'object' } },
        ],
        stream: true,
      },
    });

    expect(await drain(second.chunks)).toEqual([
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_1',
        name: 'get_weather',
        argsDelta: '{"city":"NYC"}',
        complete: true,
      },
      {
        type: 'tool_call_delta',
        index: 1,
        id: 'call_2',
        name: 'get_time',
        argsDelta: '{"tz":"EST"}',
        complete: true,
      },
    ]);
  });

  it('a mid-stream failure is not cached, a later cachedCall for the same key opens a fresh stream', async () => {
    let attempt = 0;
    const createStream = () => {
      attempt++;
      if (attempt === 1) {
        return {
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
        };
      }
      return {
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            async next(): Promise<IteratorResult<{ type: 'text-delta'; delta: string }>> {
              if (done) return { done: true, value: undefined };
              done = true;
              return { done: false, value: { type: 'text-delta', delta: 'recovered' } };
            },
          };
        },
      };
    };
    const client = { chat: { completions: { create: vi.fn(), createStream } } };
    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 0 });

    const first = await llm.cachedCall({
      cacheKey: 'fail-key',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: false, stream: true },
    });

    await expect(drain(first.chunks)).rejects.toBeInstanceOf(LLMError);
    await expect(first.finalResult).rejects.toBeInstanceOf(LLMError);

    const second = await llm.cachedCall({
      cacheKey: 'fail-key',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: false, stream: true },
    });

    expect(await drain(second.chunks)).toEqual([{ type: 'text-delta', delta: 'recovered' }]);
    await expect(second.finalResult).resolves.toBe('recovered');
  });

  it('concurrent cachedCall for the same key coalesces: the trigger gets live chunks, the joiner gets a replay once finalResult settles, both resolve to the same value', async () => {
    const { client, createStream } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'concurrent ' },
        { type: 'text-delta', delta: 'result' },
      ],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });
    const reserveUsage = vi.fn().mockResolvedValue(undefined);

    const [callA, callB] = await Promise.all([
      llm.cachedCall({
        cacheKey: 'concurrent-key',
        ttl: 60,
        call: { userContent: 'hi', jsonMode: false, stream: true },
        reserveUsage,
      }),
      llm.cachedCall({
        cacheKey: 'concurrent-key',
        ttl: 60,
        call: { userContent: 'hi', jsonMode: false, stream: true },
        reserveUsage,
      }),
    ]);

    expect(callA.chunks).not.toBe(callB.chunks);
    expect(callA.finalResult).not.toBe(callB.finalResult);

    const [chunksA, chunksB] = await Promise.all([drain(callA.chunks), drain(callB.chunks)]);

    // callA triggered the real stream, so it gets the live deltas as they
    // arrived. callB joined an already-in-flight call for the same key,
    // it has no live generation of its own to relay, so it gets a
    // one-shot replay built from the shared finalResult once that
    // settles (a single combined chunk, not the original two deltas).
    expect(chunksA).toEqual([
      { type: 'text-delta', delta: 'concurrent ' },
      { type: 'text-delta', delta: 'result' },
    ]);
    expect(chunksB).toEqual([{ type: 'text-delta', delta: 'concurrent result' }]);
    await expect(callA.finalResult).resolves.toBe('concurrent result');
    await expect(callB.finalResult).resolves.toBe('concurrent result');
    // Only one real stream was opened, the joiner shared it instead of
    // triggering a second one.
    expect(createStream).toHaveBeenCalledTimes(1);

    // Both callers reserve usage, a joiner still spends its own quota,
    // it just doesn't trigger a second stream, but only the trigger's
    // reservation is marked coalesced: false; the joiner's is true.
    expect(reserveUsage).toHaveBeenCalledTimes(2);
    const coalescedFlags = reserveUsage.mock.calls
      .map((call: unknown[]) => (call[0] as { coalesced: boolean }).coalesced)
      .sort();
    expect(coalescedFlags).toEqual([false, true]);
  });

  it('coalesces more than two concurrent callers onto a single trigger', async () => {
    const { client, createStream } = createMockStreamingClient([
      [{ type: 'text-delta', delta: 'shared' }],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const calls = await Promise.all(
      Array.from({ length: 5 }, () =>
        llm.cachedCall({
          cacheKey: 'five-way-key',
          ttl: 60,
          call: { userContent: 'hi', jsonMode: false, stream: true },
        }),
      ),
    );

    const allChunks = await Promise.all(calls.map((c) => drain(c.chunks)));
    const allResults = await Promise.all(calls.map((c) => c.finalResult));

    // Exactly one caller (the trigger) gets live chunks; the rest are
    // one-shot replays. All resolve to the same value either way.
    for (const chunks of allChunks) {
      expect(chunks).toEqual([{ type: 'text-delta', delta: 'shared' }]);
    }
    for (const result of allResults) {
      expect(result).toBe('shared');
    }
    expect(createStream).toHaveBeenCalledTimes(1);
  });

  it('a joiner sees the same rejection as the trigger when the in-flight call fails', async () => {
    const client = {
      chat: {
        completions: {
          create: vi.fn(),
          createStream: () => ({
            [Symbol.asyncIterator]() {
              let step = 0;
              return {
                async next(): Promise<IteratorResult<{ type: 'text-delta'; delta: string }>> {
                  if (step === 0) {
                    step++;
                    return { done: false, value: { type: 'text-delta', delta: 'partial' } };
                  }
                  throw new Error('dropped mid-stream');
                },
              };
            },
          }),
        },
      },
    };
    const llm = new VernLLM({ client, model: 'test-model' });

    const [callA, callB] = await Promise.all([
      llm.cachedCall({
        cacheKey: 'joiner-fail-key',
        ttl: 60,
        call: { userContent: 'hi', jsonMode: false, stream: true },
      }),
      llm.cachedCall({
        cacheKey: 'joiner-fail-key',
        ttl: 60,
        call: { userContent: 'hi', jsonMode: false, stream: true },
      }),
    ]);

    await expect(drain(callA.chunks)).rejects.toBeInstanceOf(LLMError);
    await expect(callA.finalResult).rejects.toBeInstanceOf(LLMError);
    await expect(drain(callB.chunks)).rejects.toBeInstanceOf(LLMError);
    await expect(callB.finalResult).rejects.toBeInstanceOf(LLMError);
  });

  it('does not call onUsage on a cache hit (nothing was actually spent)', async () => {
    const onUsage = vi.fn();
    const { client } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'hi' },
        { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ],
    ]);
    const llm = new VernLLM({ client, model: 'test-model', onUsage });

    const first = await llm.cachedCall({
      cacheKey: 'usage-key',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: false, stream: true },
    });
    await drain(first.chunks);
    await first.finalResult;

    expect(onUsage).toHaveBeenCalledTimes(1);
    onUsage.mockClear();

    const second = await llm.cachedCall({
      cacheKey: 'usage-key',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: false, stream: true },
    });
    await drain(second.chunks);
    await second.finalResult;

    expect(onUsage).not.toHaveBeenCalled();
  });

  it('reserves and refunds top-level usage hooks exactly once for a streaming cachedCall', async () => {
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockResolvedValue(undefined);
    const { client } = createMockStreamingClient([new Error('connect failed')]);
    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 0 });

    await expect(
      llm.cachedCall({
        cacheKey: 'reserve-key',
        ttl: 60,
        call: { userContent: 'hi', jsonMode: false, stream: true },
        reserveUsage,
        refundUsage,
      }),
    ).rejects.toBeInstanceOf(LLMError);

    expect(reserveUsage).toHaveBeenCalledTimes(1);
    expect(refundUsage).toHaveBeenCalledTimes(1);
  });

  it('reserves usage once and never refunds it for a successful streaming cachedCall', async () => {
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockResolvedValue(undefined);
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'hi there' }]]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const { chunks, finalResult } = await llm.cachedCall({
      cacheKey: 'reserve-success-key',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: false, stream: true },
      reserveUsage,
      refundUsage,
    });

    await drain(chunks);
    await expect(finalResult).resolves.toBe('hi there');

    expect(reserveUsage).toHaveBeenCalledTimes(1);
    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('a failure before the stream ever opens (reserveUsage throwing) does not permanently wedge the cache key, a later cachedCall for the same key succeeds instead of hanging forever', async () => {
    const { client, createStream } = createMockStreamingClient([
      [{ type: 'text-delta', delta: 'hello' }],
    ]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await expect(
      llm.cachedCall({
        cacheKey: 'reserve-fails-key',
        ttl: 60,
        call: { userContent: 'hi', jsonMode: false, stream: true },
        reserveUsage: async () => {
          throw new Error('quota exceeded');
        },
      }),
    ).rejects.toBeInstanceOf(LLMError);

    // A regression here would hang forever (see the bug this guards
    // against, in `registerStreamTrigger`'s docs) rather than reject or
    // resolve, so this needs its own explicit timeout: a plain
    // `await`/`expect(...).resolves` would just make the whole test suite
    // hang instead of failing this test specifically.
    const second = await Promise.race([
      llm.cachedCall({
        cacheKey: 'reserve-fails-key',
        ttl: 60,
        call: { userContent: 'hi', jsonMode: false, stream: true },
      }),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('DEADLOCK: second cachedCall never settled')), 2000),
      ),
    ]);

    expect(await drain((second as { chunks: AsyncIterable<StreamChunk> }).chunks)).toEqual([
      { type: 'text-delta', delta: 'hello' },
    ]);
    expect(createStream).toHaveBeenCalledTimes(1);
  });

  it('a connect-time failure (no reserveUsage hook at all) does not permanently wedge the cache key either', async () => {
    let attempt = 0;
    const createStream = () => {
      attempt++;
      if (attempt === 1) {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<{ type: 'text-delta'; delta: string }>> {
                throw new Error('connect failed');
              },
            };
          },
        };
      }
      return {
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            async next(): Promise<IteratorResult<{ type: 'text-delta'; delta: string }>> {
              if (done) return { done: true, value: undefined };
              done = true;
              return { done: false, value: { type: 'text-delta', delta: 'recovered' } };
            },
          };
        },
      };
    };
    const client = { chat: { completions: { create: vi.fn(), createStream } } };
    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 0 });

    await expect(
      llm.cachedCall({
        cacheKey: 'connect-fails-key',
        ttl: 60,
        call: { userContent: 'hi', jsonMode: false, stream: true },
      }),
    ).rejects.toBeInstanceOf(LLMError);

    const second = await Promise.race([
      llm.cachedCall({
        cacheKey: 'connect-fails-key',
        ttl: 60,
        call: { userContent: 'hi', jsonMode: false, stream: true },
      }),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('DEADLOCK: second cachedCall never settled')), 2000),
      ),
    ]);

    expect(await drain((second as { chunks: AsyncIterable<StreamChunk> }).chunks)).toEqual([
      { type: 'text-delta', delta: 'recovered' },
    ]);
  });
});
