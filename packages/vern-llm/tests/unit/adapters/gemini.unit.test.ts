import { describe, it, expect, vi } from 'vitest';

import { fromGemini, type GeminiClient } from '../../../src/adapters/index.js';

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

    const config = generateContent.mock.calls[0]![0].generationConfig;

    expect(config?.responseSchema).toEqual({
      ...schema,
      description: 'A response object containing an ok flag.',
    });
    expect(config?.responseMimeType).toBe('application/json');
  });

  it('translates ContentBlock[] userContent into Gemini text/inlineData parts', async () => {
    const { client, generateContent } = makeFakeGeminiClient('described');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'gemini-2.5-flash',
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

  it('throws a validation LLMError for an unsupported image mimeType', async () => {
    const { client } = makeFakeGeminiClient('unused');
    const adapted = fromGemini(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'gemini-2.5-flash',
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
    ).rejects.toMatchObject({ name: 'LLMError', type: 'validation' });
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

describe('fromGemini — tools', () => {
  const weatherTool = {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Gets the weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  };

  it('translates OpenAI-shaped tools into functionDeclarations, and tool_choice into functionCallingConfig', async () => {
    const { client, generateContent } = makeFakeGeminiClient('ok');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'gemini-2.5-flash',
        temperature: 0.2,
        max_tokens: 100,
        tools: [weatherTool],
        tool_choice: 'auto',
        messages: [{ role: 'user', content: 'weather in Oslo?' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: weatherTool.function.description,
            parameters: weatherTool.function.parameters,
          },
        ],
      },
    ]);
    expect(generateContent.mock.calls[0]![0].toolConfig).toEqual({
      functionCallingConfig: { mode: 'AUTO' },
    });
  });

  it('maps a functionCall response part into a wire tool_calls entry', async () => {
    const generateContent = vi.fn<GeminiClient['generateContent']>(async () => ({
      candidates: [
        { content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Oslo' } } }] } },
      ],
    }));
    const adapted = fromGemini({ generateContent });

    const result = await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        tools: [weatherTool],
        messages: [{ role: 'user', content: 'weather?' }],
      },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.tool_calls).toEqual([
      {
        id: 'get_weather',
        type: 'function',
        function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Oslo' }) },
      },
    ]);
  });

  it('round-trips an assistant tool_calls turn and a tool-result turn into model/user contents', async () => {
    const { client, generateContent } = makeFakeGeminiClient('sunny');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        tools: [weatherTool],
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'get_weather',
                type: 'function',
                function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Oslo' }) },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'get_weather', content: JSON.stringify({ tempC: 21 }) },
          { role: 'user', content: 'thanks, what about tomorrow?' },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].contents).toEqual([
      { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Oslo' } } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'get_weather', response: { tempC: 21 } } }],
      },
      { role: 'user', parts: [{ text: 'thanks, what about tomorrow?' }] },
    ]);
  });

  it('combines two consecutive functionResponse wire messages into a single user content entry', async () => {
    const { client, generateContent } = makeFakeGeminiClient('ok');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        tools: [weatherTool],
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'a',
                type: 'function',
                function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Oslo' }) },
              },
              {
                id: 'b',
                type: 'function',
                function: { name: 'get_time', arguments: JSON.stringify({ city: 'Oslo' }) },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'get_weather', content: JSON.stringify({ tempC: 21 }) },
          { role: 'tool', tool_call_id: 'get_time', content: JSON.stringify({ hour: 14 }) },
        ],
      },
      { signal: new AbortController().signal },
    );

    const sentContents = generateContent.mock.calls[0]![0].contents;

    expect(sentContents.filter((c) => c.role === 'user')).toHaveLength(1);
    expect(sentContents.at(-1)).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'get_weather', response: { tempC: 21 } } },
        { functionResponse: { name: 'get_time', response: { hour: 14 } } },
      ],
    });
  });
});
