import { describe, expect, it, vi } from 'vitest';

import {
  fromMistral,
  fromOpenAICompatible,
  type StreamChunk,
  VernLLM,
} from '../../../../src/index.js';

/** A fake OpenAI-shaped SSE stream, as `chat.completions.create({ stream: true })` returns. */
function fakeOpenAIStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = chunks[index];
          index++;
          return { done: false, value };
        },
      };
    },
  };
}

async function drain(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

describe('VernLLM.call(stream: true) through fromOpenAICompatible — end to end', () => {
  it('streams live text-delta chunks and resolves finalResult to the same parsed/validated shape a non-streaming call would return', async () => {
    const create = vi.fn(async (params: Record<string, unknown>) => {
      if (params.stream) {
        return fakeOpenAIStream([
          { choices: [{ delta: { content: '{"city":' } }] },
          { choices: [{ delta: { content: '"Denver"}' } }] },
          {
            choices: [{ delta: {} }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ]);
      }
      throw new Error('non-streaming create() should not be called for stream: true');
    });

    const llm = new VernLLM({
      client: fromOpenAICompatible({ chat: { completions: { create } } }),
      model: 'test-model',
    });

    const { chunks, finalResult } = await llm.call<{ city: string }>({
      userContent: 'where?',
      jsonMode: true,
      stream: true,
    });

    const collected = await drain(chunks);

    expect(collected).toEqual([
      { type: 'text-delta', delta: '{"city":' },
      { type: 'text-delta', delta: '"Denver"}' },
      {
        type: 'usage',
        usage: expect.objectContaining({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
      },
    ]);

    await expect(finalResult).resolves.toEqual({ city: 'Denver' });
  });

  it('streams tool_call_delta chunks that accumulate into the same validated ToolCall[] a non-streaming call would return', async () => {
    const create = vi.fn(async () =>
      fakeOpenAIStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    function: { name: 'get_weather', arguments: '{"city":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: '"Denver"}' } }] } },
          ],
        },
      ]),
    );

    const llm = new VernLLM({
      client: fromOpenAICompatible({ chat: { completions: { create } } }),
      model: 'test-model',
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'weather in Denver?',
      tools: [
        {
          name: 'get_weather',
          description: 'Gets the current weather for a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
      stream: true,
    });

    await drain(chunks);

    await expect(finalResult).resolves.toEqual({
      type: 'tool_calls',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Denver' } }],
    });
  });

  it('sends stream_options.include_usage by default end to end', async () => {
    let receivedParams: Record<string, unknown> | undefined;
    const create = vi.fn(async (params: Record<string, unknown>) => {
      receivedParams = params;
      return fakeOpenAIStream([{ choices: [{ delta: { content: 'hi' } }] }]);
    });

    const llm = new VernLLM({
      client: fromOpenAICompatible({ chat: { completions: { create } } }),
      model: 'test-model',
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    await drain(chunks);
    await expect(finalResult).resolves.toBe('hi');
    expect(receivedParams).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('omits stream_options end to end when supportsStreamUsage is disabled', async () => {
    let receivedParams: Record<string, unknown> | undefined;
    const create = vi.fn(async (params: Record<string, unknown>) => {
      receivedParams = params;
      return fakeOpenAIStream([{ choices: [{ delta: { content: 'hi' } }] }]);
    });

    const llm = new VernLLM({
      client: fromOpenAICompatible(
        { chat: { completions: { create } } },
        { supportsStreamUsage: false },
      ),
      model: 'test-model',
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    await drain(chunks);
    await expect(finalResult).resolves.toBe('hi');
    expect(receivedParams).toMatchObject({ stream: true });
    expect(receivedParams).not.toHaveProperty('stream_options');
  });

  it('sends stream_options.include_usage through fromMistral end to end, since Mistral supports it', async () => {
    let receivedParams: Record<string, unknown> | undefined;
    const create = vi.fn(async (params: Record<string, unknown>) => {
      receivedParams = params;
      return fakeOpenAIStream([{ choices: [{ delta: { content: 'hi' } }] }]);
    });

    const llm = new VernLLM({
      client: fromMistral({ chat: { completions: { create } } }),
      model: 'test-model',
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });

    await drain(chunks);
    await expect(finalResult).resolves.toBe('hi');
    expect(receivedParams).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });
});
