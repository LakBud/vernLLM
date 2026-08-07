import { describe, it, expect, vi } from 'vitest';

import { fromOpenAICompatible } from '../../../../src/index.js';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

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

describe('fromOpenAICompatible().chat.completions.createStream', () => {
  it('translates content deltas into text-delta WireStreamChunks', async () => {
    const create = vi.fn(async (_params: unknown, _options: unknown) =>
      fakeOpenAIStream([
        { choices: [{ delta: { content: 'Hello, ' } }] },
        { choices: [{ delta: { content: 'world!' } }] },
      ]),
    );
    const adapted = fromOpenAICompatible({ chat: { completions: { create } } });

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'test-model',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(chunks).toEqual([
      { type: 'text-delta', delta: 'Hello, ' },
      { type: 'text-delta', delta: 'world!' },
    ]);
  });

  it('translates tool_calls deltas, keyed by index, into tool_call_delta WireStreamChunks', async () => {
    const create = vi.fn(async () =>
      fakeOpenAIStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"ci' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"NYC"}' } }] } },
          ],
        },
      ]),
    );
    const adapted = fromOpenAICompatible({ chat: { completions: { create } } });

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'test-model',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'weather?' }],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(chunks).toEqual([
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_1',
        name: 'get_weather',
        argumentsDelta: '{"ci',
      },
      {
        type: 'tool_call_delta',
        index: 0,
        id: undefined,
        name: undefined,
        argumentsDelta: 'ty":"NYC"}',
      },
    ]);
  });

  it('translates a final usage block into a usage WireStreamChunk, requesting it via stream_options', async () => {
    let receivedParams: Record<string, unknown> | undefined;
    const create = vi.fn(async (params: Record<string, unknown>) => {
      receivedParams = params;
      return fakeOpenAIStream([
        { choices: [{ delta: { content: 'hi' } }] },
        {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        },
      ]);
    });
    const adapted = fromOpenAICompatible({ chat: { completions: { create } } });

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        { model: 'test-model', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
        { signal: new AbortController().signal },
      ),
    );

    expect(chunks).toContainEqual({
      type: 'usage',
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    expect(receivedParams).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('applies the same ContentBlock[] -> image_url translation as create() before streaming', async () => {
    let receivedMessages: unknown;
    const create = vi.fn(async (params: Record<string, unknown>) => {
      receivedMessages = params.messages;
      return fakeOpenAIStream([]);
    });
    const adapted = fromOpenAICompatible({ chat: { completions: { create } } });

    await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'test-model',
          max_tokens: 100,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'what is this?' },
                { type: 'image', data: 'YWJj', mimeType: 'image/png' },
              ],
            },
          ],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(receivedMessages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } },
        ],
      },
    ]);
  });
});
