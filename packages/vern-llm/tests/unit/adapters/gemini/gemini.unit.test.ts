import { describe, it, expect, vi } from 'vitest';

import { fromGemini, type GeminiClient } from '../../../../src/adapters/index.js';
import { LLMError } from '../../../../src/types/index.js';

function makeFakeGeminiClient(text: string) {
  const generateContent = vi.fn<NonNullable<GeminiClient['generateContent']>>(async (_params) => ({
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

describe('fromGemini, tools', () => {
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
        model: 'gemini-3.1-flash-lite',
        temperature: 0.2,
        max_tokens: 100,
        tools: [weatherTool],
        tool_choice: 'auto',
        messages: [{ role: 'user', content: 'weather in New York?' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].config?.tools).toEqual([
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
    expect(generateContent.mock.calls[0]![0].config?.toolConfig).toEqual({
      functionCallingConfig: { mode: 'AUTO' },
    });
  });

  it('preserves text content when Gemini also returns a functionCall', async () => {
    const generateContent = vi.fn<NonNullable<GeminiClient['generateContent']>>(async () => ({
      candidates: [
        {
          content: {
            parts: [
              { text: 'Checking the weather now.' },
              {
                functionCall: {
                  name: 'get_weather',
                  args: { city: 'New York' },
                },
              },
            ],
          },
        },
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

    expect(result.choices?.[0]?.message).toEqual({
      content: 'Checking the weather now.',
      tool_calls: [
        {
          id: 'get_weather#0',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: JSON.stringify({ city: 'New York' }),
          },
        },
      ],
    });
  });

  it('maps tool_choice none into NONE functionCallingConfig mode', async () => {
    const { client, generateContent } = makeFakeGeminiClient('ok');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        temperature: 0.2,
        max_tokens: 100,
        tools: [weatherTool],
        tool_choice: 'none',
        messages: [{ role: 'user', content: 'weather in New York?' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].config?.toolConfig).toEqual({
      functionCallingConfig: { mode: 'NONE' },
    });
  });

  it('maps tool_choice required into ANY functionCallingConfig mode', async () => {
    const { client, generateContent } = makeFakeGeminiClient('ok');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        temperature: 0.2,
        max_tokens: 100,
        tools: [weatherTool],
        tool_choice: 'required',
        messages: [{ role: 'user', content: 'weather in New York?' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].config?.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY' },
    });
  });

  it('maps a functionCall response part into a wire tool_calls entry', async () => {
    const generateContent = vi.fn<NonNullable<GeminiClient['generateContent']>>(async () => ({
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: 'get_weather', args: { city: 'New York' } } }],
          },
        },
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
        id: 'get_weather#0',
        type: 'function',
        function: { name: 'get_weather', arguments: JSON.stringify({ city: 'New York' }) },
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
                function: { name: 'get_weather', arguments: JSON.stringify({ city: 'New York' }) },
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
      {
        role: 'model',
        parts: [
          { functionCall: { id: 'get_weather', name: 'get_weather', args: { city: 'New York' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'get_weather', name: 'get_weather', response: { tempC: 21 } } },
        ],
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
                id: 'get_weather',
                type: 'function',
                function: { name: 'get_weather', arguments: JSON.stringify({ city: 'New York' }) },
              },
              {
                id: 'get_time',
                type: 'function',
                function: { name: 'get_time', arguments: JSON.stringify({ city: 'New York' }) },
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
        { functionResponse: { id: 'get_weather', name: 'get_weather', response: { tempC: 21 } } },
        { functionResponse: { id: 'get_time', name: 'get_time', response: { hour: 14 } } },
      ],
    });
  });

  it('wraps a non-object tool result (a plain string) under an "output" key for functionResponse.response', async () => {
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
                id: 'get_weather',
                type: 'function',
                function: { name: 'get_weather', arguments: JSON.stringify({ city: 'NYC' }) },
              },
            ],
          },
          // Content that parses as valid JSON but isn't a plain object
          // (here, a bare string): Gemini's real `FunctionResponse.response`
          // type requires a `Record<string, unknown>`, so this can't be
          // sent as-is and must be wrapped.
          { role: 'tool', tool_call_id: 'get_weather', content: JSON.stringify('sunny, 21C') },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].contents.at(-1)).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'get_weather',
            name: 'get_weather',
            response: { output: 'sunny, 21C' },
          },
        },
      ],
    });
  });

  it('wraps unparseable (non-JSON) tool result text under an "output" key', async () => {
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
                id: 'get_weather',
                type: 'function',
                function: { name: 'get_weather', arguments: JSON.stringify({ city: 'NYC' }) },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'get_weather', content: 'not json at all' },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].contents.at(-1)).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'get_weather',
            name: 'get_weather',
            response: { output: 'not json at all' },
          },
        },
      ],
    });
  });

  it('preserves Gemini native functionCall ids and does not collide on parallel same-tool calls', async () => {
    const generateContent = vi.fn<NonNullable<GeminiClient['generateContent']>>(async () => ({
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { id: 'call_abc', name: 'get_weather', args: { city: 'NYC' } } },
              { functionCall: { id: 'call_def', name: 'get_weather', args: { city: 'LA' } } },
            ],
          },
        },
      ],
    }));
    const adapted = fromGemini({ generateContent });

    const result = await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        max_tokens: 100,
        tools: [weatherTool],
        messages: [{ role: 'user', content: 'weather in NYC and LA?' }],
      },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.tool_calls).toEqual([
      {
        id: 'call_abc',
        type: 'function',
        function: { name: 'get_weather', arguments: JSON.stringify({ city: 'NYC' }) },
      },
      {
        id: 'call_def',
        type: 'function',
        function: { name: 'get_weather', arguments: JSON.stringify({ city: 'LA' }) },
      },
    ]);
  });

  it('synthesizes distinct ids for parallel same-tool calls when Gemini omits a native id', async () => {
    const generateContent = vi.fn<NonNullable<GeminiClient['generateContent']>>(async () => ({
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
    }));
    const adapted = fromGemini({ generateContent });

    const result = await adapted.chat.completions.create(
      {
        model: 'gemini-2.5-flash',
        max_tokens: 100,
        tools: [weatherTool],
        messages: [{ role: 'user', content: 'weather in NYC and LA?' }],
      },
      { signal: new AbortController().signal },
    );

    const ids = result.choices?.[0]?.message?.tool_calls?.map((tc) => tc.id);
    expect(ids).toEqual(['get_weather#0', 'get_weather#1']);
    expect(new Set(ids).size).toBe(2);
  });

  it('resolves functionResponse.name from history, not from the id, even when a native id looks like a function name', async () => {
    const { client, generateContent } = makeFakeGeminiClient('sunny');
    const adapted = fromGemini(client);

    // A native Gemini id that happens to have the exact shape a
    // synthesized id would have. Name resolution must not be fooled by
    // this, since it never inspects the id's shape at all.
    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        max_tokens: 100,
        tools: [weatherTool],
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'get_weather#1',
                type: 'function',
                function: { name: 'get_weather', arguments: JSON.stringify({ city: 'NYC' }) },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'get_weather#1', content: JSON.stringify({ tempC: 21 }) },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].contents.at(-1)).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'get_weather#1',
            name: 'get_weather',
            response: { tempC: 21 },
          },
        },
      ],
    });
  });
});

describe('fromGemini, accepting the full top-level client', () => {
  it('accepts { models: GeminiClient } and unwraps it internally, calling models.generateContent', async () => {
    const { client, generateContent } = makeFakeGeminiClient('hi');
    const topLevelClient = { models: client };

    const adapted = fromGemini(topLevelClient);

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

  it('still accepts a bare GeminiClient (no .models) exactly as before', async () => {
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

  it('throws LLMError(invalid_params) up front when neither the client nor .models has generateContent', () => {
    // `{ models: {} }` is a structurally valid GeminiClient (models is
    // itself a GeminiClient, and generateContent is optional), but there's
    // nothing callable at the end of the chain. fromGemini should fail
    // fast here rather than defer to a confusing runtime TypeError on the
    // first actual `.create()` call.
    expect(() => fromGemini({ models: {} })).toThrow(LLMError);
    expect(() => fromGemini({ models: {} })).toThrow(/requires a client with generateContent/);

    try {
      fromGemini({ models: {} });
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
