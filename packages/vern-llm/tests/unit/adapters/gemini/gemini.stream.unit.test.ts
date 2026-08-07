import { describe, it, expect, vi } from 'vitest';

import { fromGemini, GeminiClient } from '../../../../src';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** A fake Gemini `generateContentStream` response: an async iterable of partial responses. */
function fakeGeminiStream(chunks: unknown[]): AsyncIterable<unknown> {
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

function makeFakeStreamingGeminiClient(chunks: unknown[]) {
  const generateContent = vi.fn<GeminiClient['generateContent']>(async () => ({}));
  const generateContentStream = vi.fn(
    (_params: unknown, _options: unknown) => fakeGeminiStream(chunks) as AsyncIterable<never>,
  );

  return {
    client: { generateContent, generateContentStream } as unknown as GeminiClient,
    generateContentStream,
  };
}

describe('fromGemini().chat.completions.createStream', () => {
  it('translates part.text into text-delta WireStreamChunks', async () => {
    const { client } = makeFakeStreamingGeminiClient([
      { candidates: [{ content: { parts: [{ text: 'Hello, ' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'world!' }] } }] },
    ]);
    const adapted = fromGemini(client);

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        { model: 'gemini-2.5-flash', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
        { signal: new AbortController().signal },
      ),
    );

    expect(chunks).toEqual([
      { type: 'text-delta', delta: 'Hello, ' },
      { type: 'text-delta', delta: 'world!' },
    ]);
  });

  it('emits a complete, one-shot tool_call_delta per functionCall part (Gemini does not stream tool-call arguments incrementally)', async () => {
    const { client } = makeFakeStreamingGeminiClient([
      {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'NYC' } } }] },
          },
        ],
      },
    ]);
    const adapted = fromGemini(client);

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'gemini-2.5-flash',
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
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'get_weather',
        name: 'get_weather',
        argumentsDelta: '{"city":"NYC"}',
      },
    ]);
  });

  it('emits a single usage WireStreamChunk after the stream completes, from the last chunk carrying usageMetadata', async () => {
    const { client } = makeFakeStreamingGeminiClient([
      {
        candidates: [{ content: { parts: [{ text: 'hi' }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
      },
      {
        candidates: [{ content: { parts: [{ text: ' there' }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      },
    ]);
    const adapted = fromGemini(client);

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        { model: 'gemini-2.5-flash', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
        { signal: new AbortController().signal },
      ),
    );

    expect(chunks.at(-1)).toEqual({
      type: 'usage',
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    // Only one usage chunk, even though two chunks carried usageMetadata.
    expect(chunks.filter((c) => c.type === 'usage')).toHaveLength(1);
  });

  it('throws LLMError(validation) when the client has no generateContentStream', async () => {
    const generateContent = vi.fn<GeminiClient['generateContent']>(async () => ({}));
    const adapted = fromGemini({ generateContent });

    await expect(
      collect(
        adapted.chat.completions.createStream!(
          {
            model: 'gemini-2.5-flash',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'hi' }],
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toMatchObject({ type: 'validation' });
  });
});
