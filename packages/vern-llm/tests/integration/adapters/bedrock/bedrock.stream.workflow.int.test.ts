import { describe, expect, it, vi } from 'vitest';

import { type BedrockConverseClient, fromBedrock } from '../../../../src/adapters/index.js';
import { type StreamChunk } from '../../../../src/types/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';

/** A fake Bedrock ConverseStream event sequence, as `{ stream }` returns. */
function fakeBedrockStream(events: unknown[]): AsyncIterable<unknown> {
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

describe('VernLLM.call(stream: true) through fromBedrock, end to end', () => {
  it('streams live text-delta chunks and resolves finalResult to the same parsed/validated shape a non-streaming call would return', async () => {
    const converse = vi.fn<BedrockConverseClient['converse']>(async () => {
      throw new Error('non-streaming converse() should not be called for stream: true');
    });
    const converseStream = vi.fn(async (_params: unknown, _options: unknown) => ({
      stream: fakeBedrockStream([
        { messageStart: { role: 'assistant' } },
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: 'tool_1', name: 'location' } },
          },
        },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"city":' } } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '"Denver"}' } } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 } } },
      ]),
    }));

    const llm = new VernLLM({
      client: fromBedrock({ converse, converseStream } as unknown as BedrockConverseClient),
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    });

    // json_object is no longer supported on Bedrock (see fromBedrock's
    // docs): nothing in Converse mechanically enforces it, unlike
    // `jsonSchema`, which constrains generation for real (here, via the
    // legacy forced-single-tool-call path, since this fake client has no
    // native-structured-output override set).
    const { chunks, finalResult } = await llm.call<{ city: string }>({
      userContent: 'where?',
      jsonSchema: { name: 'location', schema: { type: 'object' } },
      stream: true,
    });

    const collected = await drain(chunks);

    expect(collected).toEqual([
      { type: 'text-delta', delta: '{"city":' },
      { type: 'text-delta', delta: '"Denver"}' },
      {
        type: 'usage',
        usage: expect.objectContaining({ promptTokens: 8, completionTokens: 5, totalTokens: 13 }),
      },
    ]);

    await expect(finalResult).resolves.toEqual({ city: 'Denver' });
  });

  it('streams a toolUse block + input deltas that accumulate into the same validated ToolCall[] a non-streaming call would return', async () => {
    const converse = vi.fn<BedrockConverseClient['converse']>(async () => ({}));
    const converseStream = vi.fn(async () => ({
      stream: fakeBedrockStream([
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: 'tool_1', name: 'get_weather' } },
          },
        },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"city":' } } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '"Denver"}' } } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { metadata: { usage: { inputTokens: 8, outputTokens: 6, totalTokens: 14 } } },
      ]),
    }));

    const llm = new VernLLM({
      client: fromBedrock({ converse, converseStream } as unknown as BedrockConverseClient),
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
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
      toolCalls: [{ id: 'tool_1', name: 'get_weather', arguments: { city: 'Denver' } }],
    });
  });

  it('streams a jsonSchema-forced toolUse block, resolving finalResult to the schema-validated object, identically to the non-streaming path', async () => {
    const converse = vi.fn<BedrockConverseClient['converse']>(async () => ({}));
    const converseStream = vi.fn(async () => ({
      stream: fakeBedrockStream([
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: 'tool_1', name: 'extract' } },
          },
        },
        {
          contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"answer":' } } },
        },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '"42"}' } } } },
        { metadata: { usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 } } },
      ]),
    }));

    const llm = new VernLLM({
      client: fromBedrock({ converse, converseStream } as unknown as BedrockConverseClient),
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
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

    // The forced toolUse block is unwrapped into plain text-delta chunks,
    // not tool_call_delta, matching how create() unwraps it into content.
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

  it('rejects finalResult with a normalized LLMError when the client has no converseStream, matching the createStream contract', async () => {
    const converse = vi.fn<BedrockConverseClient['converse']>(async () => ({}));

    const llm = new VernLLM({
      client: fromBedrock({ converse } as unknown as BedrockConverseClient),
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    });

    await expect(
      llm.call({ userContent: 'hi', jsonMode: false, stream: true }),
    ).rejects.toMatchObject({ type: 'invalid_params' });
  });
});
