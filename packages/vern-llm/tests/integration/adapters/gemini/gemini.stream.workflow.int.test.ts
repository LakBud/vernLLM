import { describe, expect, it, vi } from 'vitest';

import { fromGemini, type GeminiClient } from '../../../../src/adapters/index.js';
import { type StreamChunk } from '../../../../src/types/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';

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

async function drain(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

describe('VernLLM.call(stream: true) through fromGemini, end to end', () => {
  it('streams live text-delta chunks and resolves finalResult to the same parsed/validated shape a non-streaming call would return', async () => {
    const generateContent = vi.fn<GeminiClient['generateContent']>(async () => {
      throw new Error('non-streaming generateContent() should not be called for stream: true');
    });
    const generateContentStream = vi.fn((_params: unknown) =>
      Promise.resolve(
        fakeGeminiStream([
          {
            candidates: [{ content: { parts: [{ text: '{"city":' }] } }],
            usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 },
          },
          {
            candidates: [{ content: { parts: [{ text: '"Denver"}' }] } }],
            usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 5, totalTokenCount: 13 },
          },
        ]),
      ),
    );

    const llm = new VernLLM({
      client: fromGemini({
        generateContent,
        generateContentStream,
      } as unknown as GeminiClient),
      model: 'gemini-2.5-flash',
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
        usage: expect.objectContaining({ promptTokens: 8, completionTokens: 5, totalTokens: 13 }),
      },
    ]);

    await expect(finalResult).resolves.toEqual({ city: 'Denver' });
  });

  it('streams a complete, one-shot functionCall part that accumulates into the same validated ToolCall[] a non-streaming call would return', async () => {
    const generateContent = vi.fn<GeminiClient['generateContent']>(async () => ({}));
    const generateContentStream = vi.fn((_params: unknown) =>
      Promise.resolve(
        fakeGeminiStream([
          {
            candidates: [
              {
                content: {
                  parts: [{ functionCall: { name: 'get_weather', args: { city: 'Denver' } } }],
                },
              },
            ],
          },
        ]),
      ),
    );

    const llm = new VernLLM({
      client: fromGemini({
        generateContent,
        generateContentStream,
      } as unknown as GeminiClient),
      model: 'gemini-2.5-flash',
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
      toolCalls: [{ id: 'get_weather', name: 'get_weather', arguments: { city: 'Denver' } }],
    });
  });

  it('rejects finalResult with a normalized LLMError when the client has no generateContentStream, matching the createStream contract', async () => {
    const generateContent = vi.fn<GeminiClient['generateContent']>(async () => ({}));

    const llm = new VernLLM({
      client: fromGemini({ generateContent } as unknown as GeminiClient),
      model: 'gemini-2.5-flash',
    });

    await expect(
      llm.call({ userContent: 'hi', jsonMode: false, stream: true }),
    ).rejects.toMatchObject({ type: 'validation' });
  });
});
