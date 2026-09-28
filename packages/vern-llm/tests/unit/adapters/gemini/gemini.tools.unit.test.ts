import { describe, it, expect, vi } from 'vitest';

import { fromGemini, type GeminiClient } from '../../../../src/adapters/index.js';

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
    const generateContent = vi.fn<GeminiClient['models']['generateContent']>(async () => ({
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

    const adapted = fromGemini({ models: { generateContent } });

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

  it('defaults a text part with no text field to an empty string', async () => {
    const generateContent = vi.fn<GeminiClient['models']['generateContent']>(async () => ({
      candidates: [{ content: { parts: [{}] } }],
    }));
    const adapted = fromGemini({ models: { generateContent } });

    const result = await adapted.chat.completions.create(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.content).toBe('');
  });

  it('defaults content to an empty string when the response has no candidates at all', async () => {
    const generateContent = vi.fn<GeminiClient['models']['generateContent']>(async () => ({}));
    const adapted = fromGemini({ models: { generateContent } });

    const result = await adapted.chat.completions.create(
      { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.content).toBe('');
  });

  it('defaults tool_calls arguments to "{}" when the functionCall has no args at all', async () => {
    const generateContent = vi.fn<GeminiClient['models']['generateContent']>(async () => ({
      candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather' } }] } }],
    }));
    const adapted = fromGemini({ models: { generateContent } });

    const result = await adapted.chat.completions.create(
      {
        model: 'm',
        max_tokens: 10,
        tools: [weatherTool],
        messages: [{ role: 'user', content: 'weather?' }],
      },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.tool_calls?.[0]).toMatchObject({
      function: { arguments: '{}' },
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

  it('maps a named-function tool_choice to a restricted ANY functionCallingConfig', async () => {
    const { client, generateContent } = makeFakeGeminiClient('ok');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'gemini-3.1-flash-lite',
        temperature: 0.2,
        max_tokens: 100,
        tools: [weatherTool],
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
        messages: [{ role: 'user', content: 'weather in New York?' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].config?.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
    });
  });

  it('maps a functionCall response part into a wire tool_calls entry', async () => {
    const generateContent = vi.fn<GeminiClient['models']['generateContent']>(async () => ({
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: 'get_weather', args: { city: 'New York' } } }],
          },
        },
      ],
    }));
    const adapted = fromGemini({ models: { generateContent } });

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

  it('defaults empty tool_call arguments to an empty object instead of throwing', async () => {
    const { client, generateContent } = makeFakeGeminiClient('sunny');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        max_tokens: 10,
        tools: [weatherTool],
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } },
            ],
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].contents).toEqual([
      {
        role: 'model',
        parts: [{ functionCall: { id: 'call_1', name: 'get_weather', args: {} } }],
      },
    ]);
  });

  it("throws validation when a tool_call's arguments parse to a non-object (e.g. an array)", async () => {
    const { client } = makeFakeGeminiClient('sunny');
    const adapted = fromGemini(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'm',
          max_tokens: 10,
          tools: [weatherTool],
          messages: [
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '[1,2,3]' },
                },
              ],
            },
          ],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      type: 'validation',
      message: expect.stringContaining('arguments must be a JSON object'),
    });
  });

  it("throws a parse LLMError when a tool_call's arguments are not valid JSON at all", async () => {
    const { client } = makeFakeGeminiClient('sunny');
    const adapted = fromGemini(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'm',
          max_tokens: 10,
          tools: [weatherTool],
          messages: [
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{not valid json' },
                },
              ],
            },
          ],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      type: 'parse',
      code: 'tool_arguments_parse_failed',
      message: expect.stringContaining('are not valid JSON'),
    });
  });

  it('falls back to the tool_call_id itself as the function name when it was never seen in an assistant tool_calls turn', async () => {
    const { client, generateContent } = makeFakeGeminiClient('sunny');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        max_tokens: 10,
        tools: [weatherTool],
        messages: [
          // No preceding assistant tool_calls turn established this id,
          // so toolCallNames has no entry for it.
          { role: 'tool', tool_call_id: 'unknown_call', content: JSON.stringify({ tempC: 21 }) },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].contents).toEqual([
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'unknown_call',
              name: 'unknown_call',
              response: { tempC: 21 },
            },
          },
        ],
      },
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

  it('wraps an empty tool result string as an empty-string output, not a throw', async () => {
    const { client, generateContent } = makeFakeGeminiClient('sunny');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        max_tokens: 10,
        tools: [weatherTool],
        messages: [{ role: 'tool', tool_call_id: 'get_weather', content: '' }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].contents).toEqual([
      {
        role: 'user',
        parts: [
          {
            functionResponse: { id: 'get_weather', name: 'get_weather', response: { output: '' } },
          },
        ],
      },
    ]);
  });

  it('defaults a plain user/assistant message with no content at all to an empty text part', async () => {
    const { client, generateContent } = makeFakeGeminiClient('sunny');
    const adapted = fromGemini(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        max_tokens: 10,
        messages: [{ role: 'assistant' } as unknown as { role: 'assistant'; content: string }],
      },
      { signal: new AbortController().signal },
    );

    expect(generateContent.mock.calls[0]![0].contents).toEqual([
      { role: 'model', parts: [{ text: '' }] },
    ]);
  });

  it('preserves Gemini native functionCall ids and does not collide on parallel same-tool calls', async () => {
    const generateContent = vi.fn<GeminiClient['models']['generateContent']>(async () => ({
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
    const adapted = fromGemini({ models: { generateContent } });

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
    const generateContent = vi.fn<GeminiClient['models']['generateContent']>(async () => ({
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
    const adapted = fromGemini({ models: { generateContent } });

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
