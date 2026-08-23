import { describe, it, expect, vi } from 'vitest';

import { type AnthropicClient, fromAnthropic } from '../../../../src/adapters/index.js';
import { at, makeFakeAnthropicClient } from '../../../helpers.js';

/** A fake client that responds with a forced tool_use block instead of text. */
function makeFakeAnthropicToolClient(
  toolName: string,
  input: unknown,
  usage = { input_tokens: 10, output_tokens: 5 },
) {
  const create = vi.fn<AnthropicClient['messages']['create']>(async () => ({
    content: [{ type: 'tool_use', name: toolName, input }],
    usage,
  }));

  return {
    client: { messages: { create } },
    create,
  };
}
describe('fromAnthropic', () => {
  it("passes through an omitted temperature without crashing, so the caller can defer to Anthropic's own default", async () => {
    const { client, create } = makeFakeAnthropicClient('hi there');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect('temperature' in create.mock.calls[0]![0]).toBe(false);
  });

  it('maps system + user messages into Anthropic system/messages shape', async () => {
    const { client, create } = makeFakeAnthropicClient('hi there');
    const adapted = fromAnthropic(client);
    const controller = new AbortController();

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        temperature: 0.5,
        max_tokens: 100,
        messages: [
          { role: 'system', content: 'be nice' },
          { role: 'user', content: 'hello' },
        ],
      },
      { signal: controller.signal },
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-x',
        max_tokens: 100,
        temperature: 0.5,
        system: 'be nice',
        messages: [{ role: 'user', content: 'hello' }],
      }),
      { signal: controller.signal },
    );
  });

  it('returns content in the chat.completions.create shape', async () => {
    const { client } = makeFakeAnthropicClient('the answer');
    const adapted = fromAnthropic(client);

    const result = await adapted.chat.completions.create(
      {
        model: 'claude-x',
        temperature: 0.2,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.content).toBe('the answer');
  });

  it('maps usage from input_tokens/output_tokens to prompt/completion/total', async () => {
    const { client } = makeFakeAnthropicClient('x', { input_tokens: 7, output_tokens: 3 });
    const adapted = fromAnthropic(client);

    const result = await adapted.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
    });
  });

  it('translates ContentBlock[] userContent into Anthropic image/text blocks', async () => {
    const { client, create } = makeFakeAnthropicClient('described');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
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

    const sentParams = at(create.mock.calls, 0)[0];
    expect(sentParams.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: "what's in this image?" },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZWJhc2U2NA==' },
          },
        ],
      },
    ]);
  });

  it('throws an invalid_params LLMError for an unsupported image mimeType', async () => {
    const { client } = makeFakeAnthropicClient('unused');
    const adapted = fromAnthropic(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'claude-x',
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

  it('forces tool-use for json_schema mode instead of embedding the schema in the prompt', async () => {
    const { client, create } = makeFakeAnthropicToolClient('Candidate', { name: 'Ada' });
    const adapted = fromAnthropic(client);

    const result = await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'Candidate',
            schema: { type: 'object' },
            description: 'A candidate',
          },
        },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(create.mock.calls, 0)[0];

    // The schema is passed as a tool definition, not embedded in the system prompt
    expect(sentParams.system).toBeUndefined();
    expect(sentParams.tools).toEqual([
      { name: 'Candidate', description: 'A candidate', input_schema: { type: 'object' } },
    ]);
    expect(sentParams.tool_choice).toEqual({ type: 'tool', name: 'Candidate' });

    // The tool_use block's already-parsed input is re-serialized to a JSON string
    expect(result.choices?.[0]?.message?.content).toBe(JSON.stringify({ name: 'Ada' }));
  });

  it('forwards json_schema name and description into the Anthropic tool definition', async () => {
    const { client, create } = makeFakeAnthropicToolClient('Profile', { ok: true });
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'Profile',
            description: 'A user profile payload',
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
              },
            },
            strict: true,
          },
        },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(create.mock.calls, 0)[0];

    expect(sentParams.tools).toEqual([
      {
        name: 'Profile',
        description: 'A user profile payload',
        input_schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
        },
        strict: true,
      },
    ]);
  });

  it('throws a validation LLMError when a json_schema tool schema is missing "type": "object"', async () => {
    const { client } = makeFakeAnthropicToolClient('Profile', { ok: true });
    const adapted = fromAnthropic(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'm',
          temperature: 0.2,
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'Profile',
              // Missing `type: 'object'`, which every provider's
              // function-calling API requires.
              schema: { properties: { ok: { type: 'boolean' } } },
            },
          },
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ name: 'LLMError', type: 'validation' });
  });

  it('throws a validation LLMError when a real tool\'s parameters schema is missing "type": "object"', async () => {
    const { client } = makeFakeAnthropicClient('unused');
    const adapted = fromAnthropic(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'm',
          temperature: 0.2,
          max_tokens: 10,
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Gets the weather for a city',
                // Missing `type: 'object'`.
                parameters: { properties: { city: { type: 'string' } } },
              },
            },
          ],
          messages: [{ role: 'user', content: 'weather?' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ name: 'LLMError', type: 'validation' });
  });

  it('handles parallel tool_use responses and continuation requests with merged tool_result blocks', async () => {
    const create = vi
      .fn<AnthropicClient['messages']['create']>()
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'call_weather',
            name: 'weather',
            input: { city: 'Paris' },
          },
          {
            type: 'tool_use',
            id: 'call_time',
            name: 'time',
            input: { city: 'Paris' },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Sunny, 15:00.' }],
        usage: { input_tokens: 20, output_tokens: 5 },
      });

    const adapted = fromAnthropic({
      messages: { create },
    });

    const first = await adapted.chat.completions.create(
      {
        model: 'claude-x',
        temperature: 0.2,
        max_tokens: 100,
        tools: [
          {
            type: 'function',
            function: {
              name: 'weather',
              description: 'Gets weather',
              parameters: { type: 'object' },
            },
          },
          {
            type: 'function',
            function: {
              name: 'time',
              description: 'Gets time',
              parameters: { type: 'object' },
            },
          },
        ],
        messages: [{ role: 'user', content: 'Weather and time in Paris?' }],
      },
      { signal: new AbortController().signal },
    );

    expect(first.choices?.[0]?.message?.tool_calls).toEqual([
      {
        id: 'call_weather',
        type: 'function',
        function: {
          name: 'weather',
          arguments: JSON.stringify({ city: 'Paris' }),
        },
      },
      {
        id: 'call_time',
        type: 'function',
        function: {
          name: 'time',
          arguments: JSON.stringify({ city: 'Paris' }),
        },
      },
    ]);

    expect(at(create.mock.calls, 0)[0]).toMatchObject({
      tools: [
        {
          name: 'weather',
          description: 'Gets weather',
          input_schema: { type: 'object' },
        },
        {
          name: 'time',
          description: 'Gets time',
          input_schema: { type: 'object' },
        },
      ],
    });

    await adapted.chat.completions.create(
      {
        model: 'claude-x',
        temperature: 0.2,
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'Weather and time in Paris?' },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_weather',
                type: 'function',
                function: {
                  name: 'weather',
                  arguments: JSON.stringify({ city: 'Paris' }),
                },
              },
              {
                id: 'call_time',
                type: 'function',
                function: {
                  name: 'time',
                  arguments: JSON.stringify({ city: 'Paris' }),
                },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call_weather',
            content: 'Sunny',
          },
          {
            role: 'tool',
            tool_call_id: 'call_time',
            content: '15:00',
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(at(create.mock.calls, 1)[0].messages).toEqual([
      {
        role: 'user',
        content: 'Weather and time in Paris?',
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_weather',
            name: 'weather',
            input: { city: 'Paris' },
          },
          {
            type: 'tool_use',
            id: 'call_time',
            name: 'time',
            input: { city: 'Paris' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_weather',
            content: 'Sunny',
          },
          {
            type: 'tool_result',
            tool_use_id: 'call_time',
            content: '15:00',
          },
        ],
      },
    ]);
  });

  it('throws for json_object mode: no Anthropic field mechanically guarantees JSON output, so it is no longer emulated via a prompt instruction', async () => {
    const { client, create } = makeFakeAnthropicClient('{}');
    const adapted = fromAnthropic(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'm',
          temperature: 0.2,
          max_tokens: 10,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      name: 'LLMError',
      message: expect.stringMatching(/json_object.*not supported/i),
    });

    expect(create).not.toHaveBeenCalled();
  });

  it('works with no system message at all', async () => {
    const { client, create } = makeFakeAnthropicClient('ok');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(at(create.mock.calls, 0)[0].system).toBeUndefined();
  });

  it('preserves assistant turns and ordering for multi-turn conversations', async () => {
    const { client, create } = makeFakeAnthropicClient('Paris has about 2.1 million people.');
    const adapted = fromAnthropic(client);

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

    expect(at(create.mock.calls, 0)[0].messages).toEqual([
      { role: 'user', content: "What's the capital of France?" },
      { role: 'assistant', content: 'Paris.' },
      { role: 'user', content: "What's its population?" },
    ]);
  });
});

describe('fromAnthropic, merges multiple tool results into one user turn', () => {
  it('combines two consecutive tool-result wire messages into a single user message with two tool_result blocks', async () => {
    const { client, create } = makeFakeAnthropicClient('ok');
    const adapted = fromAnthropic(client);

    await adapted.chat.completions.create(
      {
        model: 'm',
        temperature: 0.2,
        max_tokens: 10,
        tools: [
          {
            type: 'function',
            function: { name: 't', description: 'd', parameters: { type: 'object' } },
          },
        ],
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
              { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'result a' },
          { role: 'tool', tool_call_id: 'call_2', content: 'result b' },
        ],
      },
      { signal: new AbortController().signal },
    );

    const sentMessages = at(create.mock.calls, 0)[0].messages;

    expect(sentMessages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(sentMessages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'a', input: {} },
          { type: 'tool_use', id: 'call_2', name: 'b', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'result a' },
          { type: 'tool_result', tool_use_id: 'call_2', content: 'result b' },
        ],
      },
    ]);
  });
});

describe('fromAnthropic, native structured output', () => {
  it('never uses the native path by default, so `tools` + `jsonSchema` is still rejected with no nativeStructuredOutputModels configured', async () => {
    const { client } = makeFakeAnthropicClient('unused');
    const adapted = fromAnthropic(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'claude-any-model',
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'Out', schema: { type: 'object' } },
          },
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'weather',
                parameters: { type: 'object' },
              },
            },
          ],
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      name: 'LLMError',
      type: 'invalid_params',
      code: 'unsupported_capability',
      issues: { capability: 'tools_with_json_schema' },
      message: expect.stringContaining('claude-any-model'),
    });
  });

  it('throws a validation LLMError naming the model when combining `tools` with `jsonSchema` on a model not covered by nativeStructuredOutputModels', async () => {
    const { client } = makeFakeAnthropicClient('unused');
    const adapted = fromAnthropic(client, { nativeStructuredOutputModels: ['claude-other-model'] });

    await expect(
      adapted.chat.completions.create(
        {
          model: 'claude-uncovered-model',
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'Out', schema: { type: 'object' } },
          },
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'weather',
                parameters: { type: 'object' },
              },
            },
          ],
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      name: 'LLMError',
      type: 'invalid_params',
      code: 'unsupported_capability',
      issues: { capability: 'tools_with_json_schema' },
      message: expect.stringContaining('claude-uncovered-model'),
    });
  });

  it('sends jsonSchema as output_config.format alongside real tools, unmodified, on a model covered by nativeStructuredOutputModels', async () => {
    const create = vi.fn<AnthropicClient['messages']['create']>(async () => ({
      content: [{ type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const adapted = fromAnthropic(
      { messages: { create } },
      { nativeStructuredOutputModels: ['claude-native-model'] },
    );

    const result = await adapted.chat.completions.create(
      {
        model: 'claude-native-model',
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'Out',
            schema: { type: 'object' },
            description: 'desc',
            strict: true,
          },
        },
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'weather',
              parameters: { type: 'object' },
            },
          },
        ],
        tool_choice: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(create.mock.calls, 0)[0];

    // Real tools are sent as-is, unmodified, in the normal tools field.
    expect(sentParams.tools).toEqual([
      { name: 'get_weather', description: 'weather', input_schema: { type: 'object' } },
    ]);
    expect(sentParams.tool_choice).toEqual({ type: 'auto' });

    // The schema goes in its own output_config field, not into tools. Only
    // type and schema are sent: the real Anthropic API's output_config.format
    // has no name/description/strict fields to forward `json_schema`'s
    // description/strict into, unlike the legacy forced-tool-call path.
    expect(sentParams.output_config).toEqual({
      format: { type: 'json_schema', schema: { type: 'object' } },
    });

    // No forced-tool-call unwrapping: the text content passes through as-is.
    expect(result.choices?.[0]?.message?.content).toBe('{"ok":true}');
  });

  it('sends jsonSchema alone as output_config.format (not a forced tool call) on a covered model, even with no real tools present', async () => {
    const create = vi.fn<AnthropicClient['messages']['create']>(async () => ({
      content: [{ type: 'text', text: '{"name":"Ada"}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const adapted = fromAnthropic(
      { messages: { create } },
      { nativeStructuredOutputModels: ['claude-native-model'] },
    );

    const result = await adapted.chat.completions.create(
      {
        model: 'claude-native-model',
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'Candidate', schema: { type: 'object' } },
        },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(create.mock.calls, 0)[0];

    expect(sentParams.tools).toBeUndefined();
    expect(sentParams.output_config).toEqual({
      format: { type: 'json_schema', schema: { type: 'object' } },
    });
    expect(result.choices?.[0]?.message?.content).toBe('{"name":"Ada"}');
  });

  it('still uses the legacy forced-tool-call path for jsonSchema alone on a non-covered model (regression)', async () => {
    const { client, create } = makeFakeAnthropicToolClient('Candidate', { name: 'Ada' });
    const adapted = fromAnthropic(client);

    const result = await adapted.chat.completions.create(
      {
        model: 'claude-legacy-model',
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'Candidate', schema: { type: 'object' } },
        },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(create.mock.calls, 0)[0];

    expect(sentParams.tools).toEqual([
      {
        name: 'Candidate',
        description: undefined,
        input_schema: { type: 'object' },
        strict: undefined,
      },
    ]);
    expect(sentParams.output_config).toBeUndefined();
    expect(result.choices?.[0]?.message?.content).toBe(JSON.stringify({ name: 'Ada' }));
  });

  it('supports a predicate function instead of a static list for nativeStructuredOutputModels', async () => {
    const create = vi.fn<AnthropicClient['messages']['create']>(async () => ({
      content: [{ type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const adapted = fromAnthropic(
      { messages: { create } },
      { nativeStructuredOutputModels: (model) => model.startsWith('claude-native-') },
    );

    await adapted.chat.completions.create(
      {
        model: 'claude-native-xyz',
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'Out', schema: { type: 'object' } },
        },
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'weather',
              parameters: { type: 'object' },
            },
          },
        ],
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(create.mock.calls, 0)[0];

    expect(sentParams.output_config).toBeDefined();
    expect(sentParams.tools).toEqual([
      { name: 'get_weather', description: 'weather', input_schema: { type: 'object' } },
    ]);
  });

  it('tools alone still work unmodified on a nativeStructuredOutputModels-covered model (regression)', async () => {
    const create = vi.fn<AnthropicClient['messages']['create']>(async () => ({
      content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'NYC' } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const adapted = fromAnthropic(
      { messages: { create } },
      { nativeStructuredOutputModels: ['claude-native-model'] },
    );

    const result = await adapted.chat.completions.create(
      {
        model: 'claude-native-model',
        max_tokens: 10,
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'weather',
              parameters: { type: 'object' },
            },
          },
        ],
        tool_choice: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(create.mock.calls, 0)[0];

    expect(sentParams.output_config).toBeUndefined();
    expect(result.choices?.[0]?.message?.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
      },
    ]);
  });

  describe('thinking + forced tool_choice', () => {
    it('throws invalid_params locally, without calling the client, when budget_tokens is set alongside a forced single-tool choice', async () => {
      const { client, create } = makeFakeAnthropicClient('hi there');
      const adapted = fromAnthropic(client);

      await expect(
        adapted.chat.completions.create(
          {
            model: 'claude-x',
            max_tokens: 2000,
            budget_tokens: 1024,
            tools: [
              {
                type: 'function',
                function: { name: 'summarize', description: 'x', parameters: { type: 'object' } },
              },
            ],
            tool_choice: { type: 'function', function: { name: 'summarize' } },
            messages: [{ role: 'user', content: 'hi' }],
          },
          { signal: new AbortController().signal },
        ),
      ).rejects.toMatchObject({ type: 'invalid_params' });

      expect(create).not.toHaveBeenCalled();
    });

    it('throws invalid_params when reasoning_effort is set alongside tool_choice: "required"', async () => {
      const { client, create } = makeFakeAnthropicClient('hi there');
      const adapted = fromAnthropic(client);

      await expect(
        adapted.chat.completions.create(
          {
            model: 'claude-x',
            max_tokens: 2000,
            reasoning_effort: 'low',
            tools: [
              {
                type: 'function',
                function: { name: 'summarize', description: 'x', parameters: { type: 'object' } },
              },
            ],
            tool_choice: 'required',
            messages: [{ role: 'user', content: 'hi' }],
          },
          { signal: new AbortController().signal },
        ),
      ).rejects.toMatchObject({ type: 'invalid_params' });

      expect(create).not.toHaveBeenCalled();
    });

    it('does not throw, and sends thinking, when tool_choice is left at auto', async () => {
      const { client, create } = makeFakeAnthropicClient('hi there');
      const adapted = fromAnthropic(client);

      await adapted.chat.completions.create(
        {
          model: 'claude-x',
          max_tokens: 2000,
          budget_tokens: 1024,
          tools: [
            {
              type: 'function',
              function: { name: 'summarize', description: 'x', parameters: { type: 'object' } },
            },
          ],
          tool_choice: 'auto',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      const sentParams = at(create.mock.calls, 0)[0];
      expect(sentParams.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    });

    it('throws invalid_params locally, without calling the client, when budget_tokens is set alongside a non-native response_format jsonSchema (implicit forced tool)', async () => {
      const { client, create } = makeFakeAnthropicClient('hi there');
      const adapted = fromAnthropic(client);

      await expect(
        adapted.chat.completions.create(
          {
            model: 'claude-x',
            max_tokens: 2000,
            budget_tokens: 1024,
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'Out', schema: { type: 'object' } },
            },
            messages: [{ role: 'user', content: 'hi' }],
          },
          { signal: new AbortController().signal },
        ),
      ).rejects.toMatchObject({ type: 'invalid_params' });

      expect(create).not.toHaveBeenCalled();
    });

    it('does not throw when budget_tokens is set with no tools/tool_choice at all', async () => {
      const { client, create } = makeFakeAnthropicClient('hi there');
      const adapted = fromAnthropic(client);

      await adapted.chat.completions.create(
        {
          model: 'claude-x',
          max_tokens: 2000,
          budget_tokens: 1024,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      expect(create).toHaveBeenCalledOnce();
    });
  });
});
