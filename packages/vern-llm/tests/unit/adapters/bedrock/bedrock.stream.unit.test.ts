import { describe, it, expect, vi } from 'vitest';

import { type BedrockConverseClient, fromBedrock } from '../../../../src/adapters/index.js';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

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

function makeFakeStreamingBedrockClient(events: unknown[]) {
  const converse = vi.fn<BedrockConverseClient['converse']>(async () => ({}));
  const converseStream = vi.fn(async (_params: unknown, _options: unknown) => ({
    stream: fakeBedrockStream(events),
  }));

  return {
    client: { converse, converseStream } as unknown as BedrockConverseClient,
    converseStream,
  };
}

describe('fromBedrock().chat.completions.createStream', () => {
  it('translates text deltas into text-delta WireStreamChunks', async () => {
    const { client } = makeFakeStreamingBedrockClient([
      { messageStart: { role: 'assistant' } },
      { contentBlockStart: { contentBlockIndex: 0, start: {} } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello, ' } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'world!' } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'end_turn' } },
      { metadata: { usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } } },
    ]);
    const adapted = fromBedrock(client);

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(chunks).toEqual([
      { type: 'text-delta', delta: 'Hello, ' },
      { type: 'text-delta', delta: 'world!' },
      { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
    ]);
  });

  it('translates a toolUse block + input deltas into tool_call_delta WireStreamChunks, keyed by contentBlockIndex', async () => {
    const { client } = makeFakeStreamingBedrockClient([
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: 'tool_1', name: 'get_weather' } },
        },
      },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"ci' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: 'ty":"NYC"}' } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { metadata: { usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 } } },
    ]);
    const adapted = fromBedrock(client);

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [
            {
              type: 'function',
              function: { name: 'get_weather', description: 'gets weather', parameters: {} },
            },
          ],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(chunks).toEqual([
      { type: 'tool_call_delta', index: 0, id: 'tool_1', name: 'get_weather' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"ci' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: 'ty":"NYC"}' },
      { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } },
    ]);
  });

  it('unwraps a jsonSchema-forced toolUse block into text-delta chunks (not tool_call_delta), matching the non-streaming create() path', async () => {
    const { client, converseStream } = makeFakeStreamingBedrockClient([
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: 'tool_1', name: 'extract' } },
        },
      },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"answer":' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '"42"}' } } } },
      { metadata: { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } } },
    ]);
    const adapted = fromBedrock(client);

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'question' }],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'extract', schema: { type: 'object' } },
          },
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(chunks).toEqual([
      { type: 'text-delta', delta: '{"answer":' },
      { type: 'text-delta', delta: '"42"}' },
      { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ]);

    const [sentRequest] = converseStream.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(sentRequest).toMatchObject({
      toolConfig: {
        tools: [{ toolSpec: { name: 'extract' } }],
        toolChoice: { tool: { name: 'extract' } },
      },
    });
  });

  it('discards a genuine text content block that arrives alongside a jsonSchema-forced toolUse block, instead of leaking it into the accumulated JSON text', async () => {
    const { client } = makeFakeStreamingBedrockClient([
      // A preamble text block, e.g. the model narrating before calling the
      // forced tool.
      { contentBlockStart: { contentBlockIndex: 0, start: {} } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Sure, I'll extract that." } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      {
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: 'tool_1', name: 'extract' } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { toolUse: { input: '{"answer":"42"}' } },
        },
      },
      { metadata: { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } } },
    ]);
    const adapted = fromBedrock(client);

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'question' }],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'extract', schema: { type: 'object' } },
          },
        },
        { signal: new AbortController().signal },
      ),
    );

    // The preamble text is NOT surfaced, only the forced tool's own JSON
    // payload is. If it leaked in, the accumulated text would be
    // "Sure, I'll extract that.{"answer":"42"}", which isn't valid JSON.
    expect(chunks).toEqual([
      { type: 'text-delta', delta: '{"answer":"42"}' },
      { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ]);
  });

  it('throws LLMError(validation) when the client has no converseStream', async () => {
    const converse = vi.fn<BedrockConverseClient['converse']>(async () => ({}));
    const adapted = fromBedrock({ converse });

    await expect(
      collect(
        adapted.chat.completions.createStream!(
          {
            model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'hi' }],
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toMatchObject({ type: 'validation' });
  });
});
