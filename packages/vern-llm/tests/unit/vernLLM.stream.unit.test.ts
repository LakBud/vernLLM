import { describe, it, expect, vi } from 'vitest';

import { LLMError, type StreamChunk, type WireStreamChunk } from '../../src/index.js';
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

describe('VernLLM.call — stream: true', () => {
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

  it('throws LLMError(validation) immediately when the client has no createStream', async () => {
    const llm = new VernLLM({
      client: { chat: { completions: { create: vi.fn() } } },
      model: 'test-model',
    });

    await expect(llm.call({ userContent: 'hi', stream: true })).rejects.toMatchObject({
      type: 'validation',
    });
  });

  it('retries a connection-open failure, then normalizes and records a breaker failure on exhausted retries', async () => {
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
              // already returned `{ chunks, finalResult }` — proving
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

    // Reserved by the time call() returns, refund not yet issued — that's
    // deferred onto finalResult settling.
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

  it('bounds time-to-first-chunk with withTimeout, throwing LLMError(timeout) when the stream never opens in time', async () => {
    // Built directly (not via the helper) so the mock can capture the
    // abort signal `createStream` receives and actually honor it — a real
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
                // Long pause well past timeoutMs — should NOT time out,
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
});
