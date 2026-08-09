import { describe, it, expect, vi } from 'vitest';

import { type AnthropicClient, fromAnthropic } from '../../../../src/adapters/index.js';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** A fake Anthropic SSE stream, as `messages.create({ stream: true })` returns. */
function fakeAnthropicStream(
  events: unknown[],
  onReturn?: () => void | Promise<void>,
): AsyncIterable<unknown> {
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
        async return() {
          await onReturn?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function makeFakeStreamingAnthropicClient(
  events: unknown[],
  onReturn?: () => void | Promise<void>,
) {
  const create = vi.fn(async (_params: unknown, _options: unknown) =>
    fakeAnthropicStream(events, onReturn),
  );
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

  it('translates a ping event into a WireStreamChunk ping, keeping the idle-timeout clock alive', async () => {
    const { client } = makeFakeStreamingAnthropicClient([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'ping' },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', world!' } },
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
      { type: 'text-delta', delta: 'Hello' },
      { type: 'ping' },
      { type: 'text-delta', delta: ', world!' },
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
      // forced tool, legal even under `tool_choice: { type: 'tool' }`.
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

    // The preamble text is NOT surfaced, only the forced tool's own JSON
    // payload is. If it leaked in, the accumulated text would be
    // "Sure, I'll extract that.{"answer":"42"}", which isn't valid JSON.
    expect(chunks).toEqual([
      { type: 'text-delta', delta: '{"answer":"42"}' },
      { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ]);
  });

  it('rejects with LLMError(validation) when the streamed tool_use name does not match the forced json_schema tool', async () => {
    const { client } = makeFakeStreamingAnthropicClient([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'wrong_tool' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"answer":"42"}' },
      },
      { type: 'message_delta', usage: { output_tokens: 2 } },
    ]);
    const adapted = fromAnthropic(client);

    await expect(
      collect(
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
      ),
    ).rejects.toMatchObject({ type: 'validation' });
  });

  it('rejects with LLMError(validation) when the stream ends without emitting the forced tool or any text-delta', async () => {
    const { client } = makeFakeStreamingAnthropicClient([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'message_delta', usage: { output_tokens: 0 } },
    ]);
    const adapted = fromAnthropic(client);

    await expect(
      collect(
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
      ),
    ).rejects.toMatchObject({ type: 'validation' });
  });

  it("propagates .return() on the outer generator down to the underlying SDK stream's own .return(), so VernLLM's mid-stream cleanup actually closes the connection", async () => {
    const onReturn = vi.fn();
    const { client } = makeFakeStreamingAnthropicClient(
      [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      ],
      onReturn,
    );
    const adapted = fromAnthropic(client);

    const stream = adapted.chat.completions.createStream!(
      { model: 'claude-x', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );
    const iterator = stream[Symbol.asyncIterator]();

    // Pull one chunk, then abandon iteration early, as VernLLM does when a
    // mid-stream error (e.g. an idle timeout) fires: it calls
    // `iterator.return?.()` on this generator rather than continuing to
    // pull. This relies on the language's own IteratorClose semantics for
    // `for await...of`, calling `.return()` on a generator suspended
    // inside one forwards `.return()` to the inner iterable being
    // consumed, without any adapter-specific cancellation code needed.
    await iterator.next();
    await iterator.return?.(undefined);

    expect(onReturn).toHaveBeenCalledOnce();
  });
});
