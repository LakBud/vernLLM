import { describe, it, expect, vi } from 'vitest';

import { type AnthropicClient, fromAnthropic } from '../../../../src/adapters/index.js';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

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

function makeFakeStreamingAnthropicClient(events: unknown[]) {
  const create = vi.fn(async (_params: unknown, _options: unknown) => fakeAnthropicStream(events));
  return { client: { messages: { create } } as unknown as AnthropicClient, create };
}

describe('fromAnthropic().chat.completions.createStream', () => {
  it('translates text_delta events into text-delta WireStreamChunks', async () => {
    const { client } = makeFakeStreamingAnthropicClient([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello, ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world!' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]);
    const adapted = fromAnthropic(client);

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        { model: 'claude-x', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
        { signal: new AbortController().signal },
      ),
    );

    expect(chunks).toEqual([
      { type: 'text-delta', delta: 'Hello, ' },
      { type: 'text-delta', delta: 'world!' },
      {
        type: 'usage',
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    ]);
  });

  it('translates a tool_use block + input_json_delta events into tool_call_delta WireStreamChunks', async () => {
    const { client } = makeFakeStreamingAnthropicClient([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"ci' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'ty":"NYC"}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', usage: { output_tokens: 4 } },
    ]);
    const adapted = fromAnthropic(client);

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'claude-x',
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
      { type: 'tool_call_delta', index: 0, id: 'toolu_1', name: 'get_weather' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"ci' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: 'ty":"NYC"}' },
      { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } },
    ]);
  });

  it('unwraps a jsonSchema-forced tool_use block into text-delta chunks (not tool_call_delta), matching the non-streaming create() path', async () => {
    const { client, create } = makeFakeStreamingAnthropicClient([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
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
      { type: 'message_delta', usage: { output_tokens: 2 } },
    ]);
    const adapted = fromAnthropic(client);

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'claude-x',
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

    // The forced-tool request shape (name, input_schema, forced tool_choice)
    // is identical to what the non-streaming create() path sends.
    const [sentBody] = create.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(sentBody).toMatchObject({
      tools: [{ name: 'extract' }],
      tool_choice: { type: 'tool', name: 'extract' },
      stream: true,
    });
  });

  it('discards a genuine text content block that arrives alongside a jsonSchema-forced tool_use block, instead of leaking it into the accumulated JSON text', async () => {
    const { client } = makeFakeStreamingAnthropicClient([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      // A preamble text block, e.g. the model narrating before calling the
      // forced tool — legal even under `tool_choice: { type: 'tool' }`.
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: "Sure, I'll extract that." },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'extract' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"answer":"42"}' },
      },
      { type: 'message_delta', usage: { output_tokens: 2 } },
    ]);
    const adapted = fromAnthropic(client);

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'claude-x',
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

    // The preamble text is NOT surfaced — only the forced tool's own JSON
    // payload is. If it leaked in, the accumulated text would be
    // "Sure, I'll extract that.{"answer":"42"}", which isn't valid JSON.
    expect(chunks).toEqual([
      { type: 'text-delta', delta: '{"answer":"42"}' },
      { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ]);
  });
});
