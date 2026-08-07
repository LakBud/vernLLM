import { describe, expect, it, vi } from 'vitest';

import {
  type AnthropicClient,
  fromAnthropic,
  type StreamChunk,
  VernLLM,
} from '../../../../src/index.js';

/** A fake Anthropic SSE stream, as `messages.create({ stream: true })` returns. */
function fakeAnthropicStream(events: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index >= events.length) return { done: true, value: undefined };
          const value = events[index];
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

describe('VernLLM.call(stream: true) through fromAnthropic — end to end', () => {
  it('streams live text-delta chunks and resolves finalResult to the same parsed/validated shape a non-streaming call would return', async () => {
    const create = vi.fn(async (params: Record<string, unknown>) => {
      if (params.stream) {
        return fakeAnthropicStream([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: '{"city":' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: '"Denver"}' },
          },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ]);
      }
      throw new Error('non-streaming create() should not be called for stream: true');
    });

    const llm = new VernLLM({
      client: fromAnthropic({ messages: { create } } as unknown as AnthropicClient),
      model: 'claude-x',
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

  it('streams tool_use blocks that accumulate into the same validated ToolCall[] a non-streaming call would return', async () => {
    const create = vi.fn(async () =>
      fakeAnthropicStream([
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"city":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"Denver"}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', usage: { output_tokens: 8 } },
      ]),
    );

    const llm = new VernLLM({
      client: fromAnthropic({ messages: { create } } as unknown as AnthropicClient),
      model: 'claude-x',
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

    const collected = await drain(chunks);

    expect(collected).toEqual([
      { type: 'tool_call_delta', index: 0, id: 'toolu_1', name: 'get_weather' },
      { type: 'tool_call_delta', index: 0, id: undefined, name: undefined, argsDelta: '{"city":' },
      {
        type: 'tool_call_delta',
        index: 0,
        id: undefined,
        name: undefined,
        argsDelta: '"Denver"}',
      },
      {
        type: 'usage',
        usage: {
          promptTokens: 10,
          completionTokens: 8,
          totalTokens: 18,
          requestId: expect.any(String),
          model: 'claude-x',
        },
      },
    ]);

    await expect(finalResult).resolves.toEqual({
      type: 'tool_calls',
      toolCalls: [{ id: 'toolu_1', name: 'get_weather', arguments: { city: 'Denver' } }],
    });
  });

  it('streams a jsonSchema-forced tool_use block, resolving finalResult to the schema-validated object, identically to the non-streaming path', async () => {
    const create = vi.fn(async () =>
      fakeAnthropicStream([
        { type: 'message_start', message: { usage: { input_tokens: 6 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'extract' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"answer":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"42"}' },
        },
        { type: 'message_delta', usage: { output_tokens: 3 } },
      ]),
    );

    const llm = new VernLLM({
      client: fromAnthropic({ messages: { create } } as unknown as AnthropicClient),
      model: 'claude-x',
    });

    const { chunks, finalResult } = await llm.call<{ answer: string }>({
      userContent: 'question',
      jsonSchema: {
        name: 'extract',
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        },
      },
      stream: true,
    });

    const collected = await drain(chunks);

    // The forced tool_use block is unwrapped into plain text-delta chunks,
    // not tool_call_delta — matching how create() unwraps it into content.
    expect(collected).toEqual([
      { type: 'text-delta', delta: '{"answer":' },
      { type: 'text-delta', delta: '"42"}' },
      {
        type: 'usage',
        usage: expect.objectContaining({ promptTokens: 6, completionTokens: 3, totalTokens: 9 }),
      },
    ]);

    await expect(finalResult).resolves.toEqual({ answer: '42' });
  });
});
