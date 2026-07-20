import { describe, it, expect, vi } from 'vitest';

import { fromGemini, type GeminiClient } from '../../../src/adapters/gemini.js';

function makeFakeGeminiClient(text: string) {
  const generateContent = vi.fn<GeminiClient['generateContent']>(async (_params, _options) => ({
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: {
      promptTokenCount: 4,
      candidatesTokenCount: 6,
      totalTokenCount: 10,
    },
  }));

  return { client: { generateContent }, generateContent };
}

describe('fromGemini', () => {
  it('maps messages into contents + systemInstruction', async () => {
    const { client, generateContent } = makeFakeGeminiClient('hi');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'gemini-2.5-flash',
        temperature: 0.3,
        max_tokens: 200,
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'hello' },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        systemInstruction: { parts: [{ text: 'be terse' }] },
        generationConfig: expect.objectContaining({ temperature: 0.3, maxOutputTokens: 200 }),
      }),
      { signal: expect.anything() },
    );
  });

  it('maps candidates[0].content.parts back into choices[0].message.content', async () => {
    const { client } = makeFakeGeminiClient('the response text');
    const adapted = fromGemini(client);

    const result = await adapted.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.content).toBe('the response text');
  });

  it('maps usageMetadata to prompt/completion/total tokens', async () => {
    const { client } = makeFakeGeminiClient('x');
    const adapted = fromGemini(client);

    const result = await adapted.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.usage).toEqual({
      prompt_tokens: 4,
      completion_tokens: 6,
      total_tokens: 10,
    });
  });

  it('sets responseMimeType to application/json for json_object mode', async () => {
    const { client, generateContent } = makeFakeGeminiClient('{}');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].generationConfig?.responseMimeType).toBe(
      'application/json',
    );
  });

  it('maps json_schema natively into responseSchema (provider-enforced)', async () => {
    const { client, generateContent } = makeFakeGeminiClient('{}');
    const adapted = fromGemini(client);
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        response_format: { type: 'json_schema', json_schema: { name: 'R', schema } },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const config = generateContent.mock.calls[0]![0].generationConfig;

    expect(config?.responseSchema).toEqual(schema);
    expect(config?.responseMimeType).toBe('application/json');
  });

  it('omits systemInstruction when there is no system message', async () => {
    const { client, generateContent } = makeFakeGeminiClient('ok');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].systemInstruction).toBeUndefined();
  });

  it('preserves assistant turns, mapped to Geminis "model" role, in order', async () => {
    const { client, generateContent } = makeFakeGeminiClient('About 2.1 million.');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: "What's the capital of France?" },
          { role: 'assistant', content: 'Paris.' },
          { role: 'user', content: "What's its population?" },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].contents).toEqual([
      { role: 'user', parts: [{ text: "What's the capital of France?" }] },
      { role: 'model', parts: [{ text: 'Paris.' }] },
      { role: 'user', parts: [{ text: "What's its population?" }] },
    ]);
  });
});
