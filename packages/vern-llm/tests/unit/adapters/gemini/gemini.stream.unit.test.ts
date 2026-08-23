import { describe, it, expect, vi } from 'vitest';

import { fromGemini, type GeminiClient } from '../../../../src/index.js';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** A fake Gemini `generateContentStream` response: an async iterable of partial responses. */
function fakeGeminiStream(
  chunks: unknown[],
  onReturn?: () => void | Promise<void>,
): AsyncIterable<unknown> {
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
        async return() {
          await onReturn?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function makeFakeStreamingGeminiClient(chunks: unknown[], onReturn?: () => void | Promise<void>) {
  const generateContent = vi.fn<NonNullable<GeminiClient['generateContent']>>(async () => ({}));
  const generateContentStream = vi.fn((_params: unknown) =>
    Promise.resolve(fakeGeminiStream(chunks, onReturn) as AsyncIterable<never>),
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
        {
          model: 'gemini-3.1-flash-lite',
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

  it('INVARIANT: hardcodes complete: true on tool_call_delta (Gemini does not stream tool-call arguments incrementally); if this ever fails, Gemini changed and gemini.ts needs a real completion signal', async () => {
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
          model: 'gemini-3.1-flash-lite',
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
        id: 'get_weather#0',
        name: 'get_weather',
        argumentsDelta: '{"city":"NYC"}',
        complete: true,
      },
    ]);
  });

  it('preserves a native functionCall id on the streaming path', async () => {
    const { client } = makeFakeStreamingGeminiClient([
      {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { id: 'call_abc', name: 'get_weather', args: { city: 'NYC' } } },
              ],
            },
          },
        ],
      },
    ]);
    const adapted = fromGemini(client);

    const chunks = await collect(
      adapted.chat.completions.createStream!(
        {
          model: 'gemini-3.1-flash-lite',
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

    expect(chunks[0]).toMatchObject({ type: 'tool_call_delta', id: 'call_abc' });
  });

  it('synthesizes distinct ids on the streaming path for parallel calls to the same tool', async () => {
    const { client } = makeFakeStreamingGeminiClient([
      {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'get_weather', args: { city: 'NYC' } } },
                { functionCall: { name: 'get_weather', args: { city: 'LA' } } },
              ],
            },
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
          messages: [{ role: 'user', content: 'weather in NYC and LA?' }],
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

    const ids = chunks
      .filter((c) => c.type === 'tool_call_delta')
      .map((c) => (c as { id?: string }).id);
    expect(ids).toEqual(['get_weather#0', 'get_weather#1']);
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
        {
          model: 'gemini-3.1-flash-lite',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
        },
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
    const generateContent = vi.fn<NonNullable<GeminiClient['generateContent']>>(async () => ({}));
    const adapted = fromGemini({ generateContent });

    await expect(
      collect(
        adapted.chat.completions.createStream!(
          {
            model: 'gemini-3.1-flash-lite',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'hi' }],
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toMatchObject({ type: 'invalid_params' });
  });

  it('throws LLMError(invalid_params), not a native TypeError, when generateContentStream is present but not a function', async () => {
    // A truthy but non-callable value is a structurally valid GeminiClient
    // (the interface can't enforce "must be callable" at the type level),
    // so this exercises the runtime `typeof === 'function'` guard rather
    // than the plain truthiness check it replaced.
    const client = {
      generateContent: vi.fn(async () => ({})),
      generateContentStream: 'not a function',
    } as unknown as GeminiClient;
    const adapted = fromGemini(client);

    await expect(
      collect(
        adapted.chat.completions.createStream!(
          {
            model: 'gemini-3.1-flash-lite',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'hi' }],
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toMatchObject({
      type: 'invalid_params',
      code: 'unsupported_capability',
      issues: { capability: 'generateContentStream' },
    });
  });

  it("propagates .return() on the outer generator down to the underlying SDK stream's own .return()", async () => {
    const onReturn = vi.fn();
    const { client } = makeFakeStreamingGeminiClient(
      [{ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }],
      onReturn,
    );
    const adapted = fromGemini(client);

    const stream = adapted.chat.completions.createStream!(
      {
        model: 'gemini-3.1-flash-lite',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );
    const iterator = stream[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.return?.(undefined);

    expect(onReturn).toHaveBeenCalledOnce();
  });
});
