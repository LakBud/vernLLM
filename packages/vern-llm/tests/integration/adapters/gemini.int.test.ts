import { describe, expect, it, vi } from 'vitest';

import { fromGemini } from '../../../src/adapters/gemini.js';

describe('Gemini adapter integration', () => {
  it('maps generateContent into LLMClient format', async () => {
    const gemini = {
      generateContent: vi.fn(async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '{"hello":"world"}',
                },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      })),
    };

    const client = fromGemini(gemini);

    const result = await client.chat.completions.create(
      {
        model: 'gemini-test',
        temperature: 0.1,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: 'hello',
          },
        ],
        response_format: {
          type: 'json_object',
        },
      },
      {
        signal: new AbortController().signal,
      },
    );

    expect(result.choices?.[0]?.message?.content).toBe('{"hello":"world"}');

    expect(result.usage?.total_tokens).toBe(15);

    expect(gemini.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-test',
        generationConfig: expect.objectContaining({
          responseMimeType: 'application/json',
        }),
      }),
      expect.anything(),
    );
  });

  it('sends prior assistant turns as Geminis "model" role instead of dropping them', async () => {
    const gemini = {
      generateContent: vi.fn(async () => ({
        candidates: [{ content: { parts: [{ text: 'About 2.1 million.' }] } }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 6, totalTokenCount: 26 },
      })),
    };

    const client = fromGemini(gemini);

    await client.chat.completions.create(
      {
        model: 'gemini-test',
        temperature: 0.1,
        max_tokens: 100,
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: "What's the capital of France?" },
          { role: 'assistant', content: 'Paris.' },
          { role: 'user', content: "What's its population?" },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(gemini.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: [
          { role: 'user', parts: [{ text: "What's the capital of France?" }] },
          { role: 'model', parts: [{ text: 'Paris.' }] },
          { role: 'user', parts: [{ text: "What's its population?" }] },
        ],
      }),
      expect.anything(),
    );
  });
});
