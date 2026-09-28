import { describe, it, expect, vi } from 'vitest';

import { fromBedrock } from '../../src/index.js';
import { stubbedClient, type ConverseHandler } from '../helpers.js';

function makeFakeBedrockClient(text: string) {
  const converse = vi.fn<ConverseHandler>(async (_params, _options) => ({
    output: { message: { content: [{ text }] } },
    usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
  }));

  return { client: stubbedClient({ converse }), converse };
}

/** A fake client that responds with a forced toolUse block instead of text. */
function makeFakeBedrockToolClient(toolName: string, input: unknown) {
  const converse = vi.fn<ConverseHandler>(async (_params, _options) => ({
    output: { message: { content: [{ toolUse: { name: toolName, input } }] } },
    usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
  }));

  return { client: stubbedClient({ converse }), converse };
}

describe('fromBedrock, tools', () => {
  const weatherTool = {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Gets the weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  };

  it('throws a clear invalid_params error for toolChoice: none, instead of silently falling back to auto', async () => {
    const { client } = makeFakeBedrockClient('ok');
    const adapted = fromBedrock(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'm',
          temperature: 0.2,
          max_tokens: 10,
          tools: [weatherTool],
          tool_choice: 'none',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ type: 'invalid_params' });
  });

  it('translates OpenAI-shaped tools into toolConfig.tools, and tool_choice into toolConfig.toolChoice', async () => {
    const { client, converse } = makeFakeBedrockClient('ok');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        temperature: 0.2,
        max_tokens: 100,
        tools: [weatherTool],
        tool_choice: 'required',
        messages: [{ role: 'user', content: 'weather in New York?' }],
      },
      { signal: new AbortController().signal },
    );

    expect(converse.mock.calls[0]![0].toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: 'get_weather',
            description: weatherTool.function.description,
            inputSchema: { json: weatherTool.function.parameters },
          },
        },
      ],
      toolChoice: { any: {} },
    });
  });

  it('maps a toolUse content block into a wire tool_calls entry', async () => {
    const { client } = makeFakeBedrockToolClient('get_weather', { city: 'New York' });
    const adapted = fromBedrock(client);

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
        id: 'get_weather_0',
        type: 'function',
        function: { name: 'get_weather', arguments: JSON.stringify({ city: 'New York' }) },
      },
    ]);
  });

  it('defaults tool_calls arguments to "{}" when the toolUse block has no input at all', async () => {
    const converse = vi.fn<ConverseHandler>(async () => ({
      output: {
        message: { content: [{ toolUse: { toolUseId: 'call_1', name: 'get_weather' } }] },
      },
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    }));
    const adapted = fromBedrock(stubbedClient({ converse }));

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

  it('throws a validation LLMError when a toolUse block is returned without a name', async () => {
    const converse = vi.fn<ConverseHandler>(async () => ({
      output: {
        message: { content: [{ toolUse: { toolUseId: 'call_1', input: {} } }] },
      },
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    }));
    const adapted = fromBedrock(stubbedClient({ converse }));

    await expect(
      adapted.chat.completions.create(
        {
          model: 'm',
          max_tokens: 10,
          tools: [weatherTool],
          messages: [{ role: 'user', content: 'weather?' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      name: 'LLMError',
      type: 'validation',
      message: expect.stringContaining('toolUse block without a name'),
    });
  });

  it('defaults text content to an empty string when Bedrock omits message.content entirely', async () => {
    const converse = vi.fn<ConverseHandler>(async () => ({
      output: { message: {} },
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    }));
    const adapted = fromBedrock(stubbedClient({ converse }));

    const result = await adapted.chat.completions.create(
      {
        model: 'm',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.content).toBe('');
  });

  it('round-trips an assistant tool_calls turn and a tool-result turn into assistant/user Converse messages', async () => {
    const { client, converse } = makeFakeBedrockClient('sunny');
    const adapted = fromBedrock(client);

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
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: JSON.stringify({ city: 'New York' }) },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ tempC: 21 }) },
          { role: 'user', content: 'thanks, what about tomorrow?' },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(converse.mock.calls[0]![0].messages).toEqual([
      {
        role: 'assistant',
        content: [
          { toolUse: { toolUseId: 'call_1', name: 'get_weather', input: { city: 'New York' } } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'call_1',
              content: [{ text: JSON.stringify({ tempC: 21 }) }],
              status: 'success',
            },
          },
          { text: 'thanks, what about tomorrow?' },
        ],
      },
    ]);
  });

  it('maps a tool-result turn with is_error true to a Converse toolResult with status error', async () => {
    const { client, converse } = makeFakeBedrockClient('sunny');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        max_tokens: 10,
        tools: [weatherTool],
        messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'boom', is_error: true }],
      },
      { signal: new AbortController().signal },
    );

    expect(converse.mock.calls[0]![0].messages![0]!.content![0]).toMatchObject({
      toolResult: { status: 'error' },
    });
  });

  it('includes leading assistant text alongside tool_calls as a text block', async () => {
    const { client, converse } = makeFakeBedrockClient('sunny');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        max_tokens: 10,
        tools: [weatherTool],
        messages: [
          {
            role: 'assistant',
            content: 'Sure, let me check that.',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: JSON.stringify({ city: 'NYC' }) },
              },
            ],
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(converse.mock.calls[0]![0].messages![0]!.content![0]).toEqual({
      text: 'Sure, let me check that.',
    });
  });

  it('defaults an assistant tool_call with empty/whitespace-only arguments to an empty input object', async () => {
    const { client, converse } = makeFakeBedrockClient('sunny');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
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
                function: { name: 'get_weather', arguments: '  ' },
              },
            ],
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(converse.mock.calls[0]![0].messages).toEqual([
      {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 'call_1', name: 'get_weather', input: {} } }],
      },
    ]);
  });

  it('combines two consecutive toolResult wire messages into a single user Converse message', async () => {
    const { client, converse } = makeFakeBedrockClient('ok');
    const adapted = fromBedrock(client);

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
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: JSON.stringify({ city: 'New York' }) },
              },
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'get_time', arguments: JSON.stringify({ city: 'New York' }) },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ tempC: 21 }) },
          { role: 'tool', tool_call_id: 'call_2', content: JSON.stringify({ hour: 14 }) },
        ],
      },
      { signal: new AbortController().signal },
    );

    const sentMessages = converse.mock.calls[0]![0].messages!;

    expect(sentMessages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(sentMessages.at(-1)).toEqual({
      role: 'user',
      content: [
        {
          toolResult: {
            toolUseId: 'call_1',
            content: [{ text: JSON.stringify({ tempC: 21 }) }],
            status: 'success',
          },
        },
        {
          toolResult: {
            toolUseId: 'call_2',
            content: [{ text: JSON.stringify({ hour: 14 }) }],
            status: 'success',
          },
        },
      ],
    });
  });

  it('merges a tool result and a following user turn so roles strictly alternate', async () => {
    const { client, converse } = makeFakeBedrockClient('ok');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        tools: [weatherTool],
        messages: [
          { role: 'user', content: 'Weather in New York?' },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: JSON.stringify({ city: 'New York' }) },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ tempC: 21 }) },
          { role: 'user', content: 'Answer in Fahrenheit.' },
        ],
      },
      { signal: new AbortController().signal },
    );

    const sentMessages = converse.mock.calls[0]![0].messages!;

    expect(sentMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(sentMessages.at(-1)).toEqual({
      role: 'user',
      content: [
        {
          toolResult: {
            toolUseId: 'call_1',
            content: [{ text: JSON.stringify({ tempC: 21 }) }],
            status: 'success',
          },
        },
        { text: 'Answer in Fahrenheit.' },
      ],
    });
  });

  it('merges consecutive plain user and assistant turns', async () => {
    const { client, converse } = makeFakeBedrockClient('ok');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        messages: [
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' },
          { role: 'assistant', content: 'c' },
          { role: 'assistant', content: 'd' },
          { role: 'user', content: 'e' },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(converse.mock.calls[0]![0].messages).toEqual([
      { role: 'user', content: [{ text: 'a' }, { text: 'b' }] },
      { role: 'assistant', content: [{ text: 'c' }, { text: 'd' }] },
      { role: 'user', content: [{ text: 'e' }] },
    ]);
  });

  it('rejects assistant tool_calls with non-empty invalid JSON arguments', async () => {
    const { client } = makeFakeBedrockClient('unused');
    const adapted = fromBedrock(client);

    await expect(
      adapted.chat.completions.create(
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
                  id: 'call_bad_json',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{not valid json}',
                  },
                },
              ],
            },
          ],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      name: 'LLMError',
      type: 'validation',
    });
  });
});
