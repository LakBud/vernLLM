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
describe('fromAnthropic, structured output', () => {
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

  it('throws a validation LLMError when json_schema.name is empty or whitespace-only', async () => {
    const { client, create } = makeFakeAnthropicClient('hi there');
    const adapted = fromAnthropic(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'm',
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: { name: '   ', schema: { type: 'object' } },
          },
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      type: 'validation',
      message: expect.stringContaining('json_schema.name must not be empty'),
    });

    expect(create).not.toHaveBeenCalled();
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

  it('throws validation when Anthropic never returns the required structured-output tool_use block', async () => {
    const create = vi.fn<AnthropicClient['messages']['create']>(async () => ({
      content: [{ type: 'text', text: 'I refuse to use tools' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const adapted = fromAnthropic({ messages: { create } });

    await expect(
      adapted.chat.completions.create(
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
      ),
    ).rejects.toMatchObject({
      type: 'validation',
      message: expect.stringContaining('did not return the required structured output tool'),
    });
  });

  it('throws validation when Anthropic returns non-object structured-output tool input (an array)', async () => {
    const { client } = makeFakeAnthropicToolClient('Candidate', ['not', 'an', 'object']);
    const adapted = fromAnthropic(client);

    await expect(
      adapted.chat.completions.create(
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
      ),
    ).rejects.toMatchObject({
      type: 'validation',
      message: expect.stringContaining('Expected an object'),
    });
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
});
