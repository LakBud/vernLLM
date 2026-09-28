import { describe, it, expect, vi } from 'vitest';

import { fromGemini, type GeminiClient } from '../../../../src/adapters/index.js';
import { LLMError } from '../../../../src/types/index.js';

function makeFakeGeminiClient(text: string) {
  const generateContent = vi.fn<GeminiClient['models']['generateContent']>(async (_params) => ({
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: {
      promptTokenCount: 4,
      candidatesTokenCount: 6,
      totalTokenCount: 10,
    },
  }));

  return { client: { models: { generateContent } }, generateContent };
}

describe('fromGemini', () => {
  it('passes through an omitted temperature via config without crashing', async () => {
    const { client, generateContent } = makeFakeGeminiClient('hi');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        max_tokens: 200,
        messages: [{ role: 'user', content: 'hello' }],
      },
      { signal: new AbortController().signal },
    );

    expect('temperature' in (generateContent.mock.calls[0]![0].config ?? {})).toBe(false);
  });

  it('maps messages into contents + config.systemInstruction, and folds abortSignal into config', async () => {
    const { client, generateContent } = makeFakeGeminiClient('hi');
    const adapted = fromGemini(client);
    const signal = new AbortController().signal;

    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        temperature: 0.3,
        max_tokens: 200,
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'hello' },
        ],
      },
      { signal },
    );

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.1-flash-lite',
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        config: expect.objectContaining({
          systemInstruction: { parts: [{ text: 'be terse' }] },
          temperature: 0.3,
          maxOutputTokens: 200,
          abortSignal: signal,
        }),
      }),
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

    expect(generateContent.mock.calls[0]![0].config?.responseMimeType).toBe('application/json');
  });

  it('maps json_schema natively into responseSchema with description (provider-enforced)', async () => {
    const { client, generateContent } = makeFakeGeminiClient('{}');
    const adapted = fromGemini(client);
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'R',
            description: 'A response object containing an ok flag.',
            schema,
          },
        },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const config = generateContent.mock.calls[0]![0].config;

    expect(config?.responseSchema).toEqual({
      ...schema,
      description: 'A response object containing an ok flag.',
    });
    expect(config?.responseMimeType).toBe('application/json');
  });

  it('maps json_schema natively into responseSchema without a description when none is given', async () => {
    const { client, generateContent } = makeFakeGeminiClient('{}');
    const adapted = fromGemini(client);
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };

    await adapted.chat.completions.create(
      {
        model: 'm',
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'R', schema },
        },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const config = generateContent.mock.calls[0]![0].config;
    expect(config?.responseSchema).toEqual(schema);
    expect(config?.responseSchema).not.toHaveProperty('description');
  });

  it('translates ContentBlock[] userContent into Gemini text/inlineData parts', async () => {
    const { client, generateContent } = makeFakeGeminiClient('described');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        temperature: 0.2,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: "what's in this image?" },
              { type: 'image', data: 'ZmFrZWJhc2U2NA==', mimeType: 'image/png' },
            ],
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: "what's in this image?" },
          { inlineData: { mimeType: 'image/png', data: 'ZmFrZWJhc2U2NA==' } },
        ],
      },
    ]);
  });

  it('throws an invalid_params LLMError for an unsupported image mimeType', async () => {
    const { client } = makeFakeGeminiClient('unused');
    const adapted = fromGemini(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'gemini-3.1-flash-lite',
          temperature: 0.2,
          max_tokens: 100,
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', data: 'ZmFrZQ==', mimeType: 'image/tiff' }],
            },
          ],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ name: 'LLMError', type: 'invalid_params' });
  });

  it('omits config.systemInstruction when there is no system message', async () => {
    const { client, generateContent } = makeFakeGeminiClient('ok');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].config?.systemInstruction).toBeUndefined();
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

describe('fromGemini, taking the top level client only', () => {
  it('calls models.generateContent on the top level client', async () => {
    const { client, generateContent } = makeFakeGeminiClient('hi');

    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        max_tokens: 200,
        messages: [{ role: 'user', content: 'hello' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('throws LLMError(invalid_params) at construction when given ai.models, pointing to ai', () => {
    const { client } = makeFakeGeminiClient('hi');
    const passModels = () => fromGemini(client.models as unknown as GeminiClient);

    expect(passModels).toThrow(LLMError);
    expect(passModels).toThrow('fromGemini takes the top level client: pass ai');
    expect(passModels).toThrow(expect.objectContaining({ type: 'invalid_params' }));
  });

  it('throws LLMError(invalid_params) up front when models has no generateContent', () => {
    // Fail fast here rather than defer to a confusing runtime TypeError on
    // the first actual `.create()` call.
    const empty = { models: {} } as unknown as GeminiClient;
    expect(() => fromGemini(empty)).toThrow(LLMError);
    expect(() => fromGemini(empty)).toThrow(/requires a client with models\.generateContent/);

    try {
      fromGemini(empty);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        type: 'invalid_params',
        code: 'unsupported_capability',
        issues: { capability: 'generateContent' },
      });
    }
  });

  it('throws LLMError(invalid_params), not a native TypeError, when generateContent is present but not a function', () => {
    // A truthy but non-callable value is a structurally valid GeminiClient
    // (the interface can't enforce "must be callable" at the type level),
    // so this exercises the runtime `typeof === 'function'` guard rather
    // than the plain truthiness check it replaced.
    expect(() =>
      fromGemini({ generateContent: 'not a function' } as unknown as GeminiClient),
    ).toThrow(LLMError);

    try {
      fromGemini({ generateContent: 'not a function' } as unknown as GeminiClient);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        type: 'invalid_params',
        code: 'unsupported_capability',
        issues: { capability: 'generateContent' },
      });
    }
  });
});

describe('fromGemini, finish reason', () => {
  const request = {
    model: 'gemini-x',
    max_tokens: 10,
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it.each([
    ['MAX_TOKENS', 'length'],
    ['STOP', undefined],
  ])('maps finishReason %s to finish_reason %s', async (finishReason, expected) => {
    const generateContent = vi.fn<GeminiClient['models']['generateContent']>(async () => ({
      candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason }],
    }));

    const result = await fromGemini({ models: { generateContent } }).chat.completions.create(
      request,
      {
        signal: new AbortController().signal,
      },
    );

    expect(result.choices?.[0]?.finish_reason).toBe(expected);
  });
});
