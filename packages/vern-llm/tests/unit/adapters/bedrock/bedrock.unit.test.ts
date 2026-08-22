import { describe, it, expect, vi } from 'vitest';

import { type BedrockConverseClient, fromBedrock } from '../../../../src/adapters/index.js';
import { at } from '../../../helpers.js';

function makeFakeBedrockClient(text: string) {
  const converse = vi.fn<BedrockConverseClient['converse']>(async (_params, _options) => ({
    output: { message: { content: [{ text }] } },
    usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
  }));

  return { client: { converse }, converse };
}

/** A fake client that responds with a forced toolUse block instead of text. */
function makeFakeBedrockToolClient(toolName: string, input: unknown) {
  const converse = vi.fn<BedrockConverseClient['converse']>(async (_params, _options) => ({
    output: { message: { content: [{ toolUse: { name: toolName, input } }] } },
    usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
  }));

  return { client: { converse }, converse };
}

describe('fromBedrock', () => {
  it('maps model to modelId and messages/system correctly', async () => {
    const { client, converse } = makeFakeBedrockClient('hi');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        temperature: 0.4,
        max_tokens: 300,
        messages: [
          { role: 'system', content: 'be concise' },
          { role: 'user', content: 'hello' },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(converse).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: [{ text: 'hello' }] }],
        system: [{ text: 'be concise' }],
        inferenceConfig: { temperature: 0.4, maxTokens: 300 },
      }),
      { signal: expect.anything() },
    );
  });

  it('passes through an omitted temperature via inferenceConfig without crashing', async () => {
    const { client, converse } = makeFakeBedrockClient('hi');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        max_tokens: 300,
        messages: [{ role: 'user', content: 'hello' }],
      },
      { signal: new AbortController().signal },
    );

    expect('temperature' in (converse.mock.calls[0]![0].inferenceConfig ?? {})).toBe(false);
  });

  it('translates ContentBlock[] userContent into Converse image/text blocks, decoding base64 to bytes', async () => {
    const { client, converse } = makeFakeBedrockClient('described');
    const adapted = fromBedrock(client);
    const base64 = 'ZmFrZWJhc2U2NA==';

    await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        temperature: 0.2,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: "what's in this image?" },
              { type: 'image', data: base64, mimeType: 'image/png' },
            ],
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(converse.mock.calls, 0)[0];
    const content = sentParams.messages[0]!.content;

    expect(content[0]).toEqual({ text: "what's in this image?" });
    expect(content[1]).toMatchObject({ image: { format: 'png' } });

    const imageBlock = content[1] as { image: { format: string; source: { bytes: Uint8Array } } };
    expect(Array.from(imageBlock.image.source.bytes)).toEqual(
      Array.from(Buffer.from(base64, 'base64')),
    );
  });

  it('throws an invalid_params LLMError for an unsupported image mimeType', async () => {
    const { client } = makeFakeBedrockClient('unused');
    const adapted = fromBedrock(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
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

  it('maps output.message.content back into choices[0].message.content', async () => {
    const { client } = makeFakeBedrockClient('bedrock response');
    const adapted = fromBedrock(client);

    const result = await adapted.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.content).toBe('bedrock response');
  });

  it('maps usage fields', async () => {
    const { client } = makeFakeBedrockClient('x');
    const adapted = fromBedrock(client);

    const result = await adapted.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(result.usage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 2,
      total_tokens: 10,
    });
  });

  it('throws for json_object mode: Converse has no field that mechanically guarantees JSON output, so it is no longer emulated via a prompt instruction', async () => {
    const { client, converse } = makeFakeBedrockClient('{}');
    const adapted = fromBedrock(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'm',
          temperature: 0.2,
          max_tokens: 10,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'be brief' },
            { role: 'user', content: 'hi' },
          ],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      name: 'LLMError',
      message: expect.stringMatching(/json_object.*not supported/i),
    });

    expect(converse).not.toHaveBeenCalled();
  });

  it('forces tool-use via toolConfig for json_schema mode instead of a prompt instruction', async () => {
    const { client, converse } = makeFakeBedrockToolClient('Candidate', { name: 'Ada' });
    const adapted = fromBedrock(client);

    const result = await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-test',
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

    const sentParams = at(converse.mock.calls, 0)[0];

    expect(sentParams.system).toBeUndefined();
    expect(sentParams.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: 'Candidate',
            description: 'A candidate',
            inputSchema: { json: { type: 'object' } },
          },
        },
      ],
      toolChoice: { tool: { name: 'Candidate' } },
    });

    // The toolUse block's already-parsed input is re-serialized to a JSON string
    expect(result.choices?.[0]?.message?.content).toBe(JSON.stringify({ name: 'Ada' }));
  });

  it('forwards json_schema name and description into Bedrock toolSpec', async () => {
    const { client, converse } = makeFakeBedrockToolClient('Profile', { ok: true });
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      {
        model: 'anthropic.claude-test',
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

    const sentParams = at(converse.mock.calls, 0)[0];

    expect(sentParams.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: 'Profile',
            description: 'A user profile payload',
            inputSchema: {
              json: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                },
              },
            },
            strict: true,
          },
        },
      ],
      toolChoice: { tool: { name: 'Profile' } },
    });
  });

  it('leaves system undefined when there is no system message and no JSON mode', async () => {
    const { client, converse } = makeFakeBedrockClient('ok');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
      { model: 'm', temperature: 0.2, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );

    expect(at(converse.mock.calls, 0)[0].system).toBeUndefined();
  });

  it('preserves assistant turns and ordering for multi-turn conversations', async () => {
    const { client, converse } = makeFakeBedrockClient('About 2.1 million.');
    const adapted = fromBedrock(client);

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

    expect(at(converse.mock.calls, 0)[0].messages).toEqual([
      { role: 'user', content: [{ text: "What's the capital of France?" }] },
      { role: 'assistant', content: [{ text: 'Paris.' }] },
      { role: 'user', content: [{ text: "What's its population?" }] },
    ]);
  });

  it('propagates Bedrock errors as-is for json_schema calls, without reclassification', async () => {
    // Converse rejects tool-use for an unsupported model. VernLLM doesn't
    // attempt to guess this from the error text (see the fromBedrock doc
    // comment); the raw error should surface unchanged.
    const error = new Error('ValidationException: tool use is not supported for this model');

    const converse = vi.fn<BedrockConverseClient['converse']>(async () => {
      throw error;
    });

    const adapted = fromBedrock({ converse });

    await expect(
      adapted.chat.completions.create(
        {
          model: 'unsupported-model',
          temperature: 0.2,
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'Candidate',
              schema: { type: 'object' },
            },
          },
          messages: [{ role: 'user', content: 'extract data' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toBe(error);
  });

  describe('toolUseSupportedModels preflight', () => {
    it('rejects with an invalid_params LLMError, without calling converse, when the model is not in the allowlist', async () => {
      const { client, converse } = makeFakeBedrockClient('unused');
      const adapted = fromBedrock(client, { toolUseSupportedModels: ['supported-model'] });

      await expect(
        adapted.chat.completions.create(
          {
            model: 'unsupported-model',
            temperature: 0.2,
            max_tokens: 10,
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'Candidate', schema: { type: 'object' } },
            },
            messages: [{ role: 'user', content: 'extract data' }],
          },
          { signal: new AbortController().signal },
        ),
      ).rejects.toMatchObject({ name: 'LLMError', type: 'invalid_params' });

      expect(converse).not.toHaveBeenCalled();
    });

    it('proceeds normally when the model is in the allowlist', async () => {
      const { client, converse } = makeFakeBedrockClient('ok');
      const adapted = fromBedrock(client, { toolUseSupportedModels: ['supported-model'] });

      await adapted.chat.completions.create(
        {
          model: 'supported-model',
          temperature: 0.2,
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'Candidate', schema: { type: 'object' } },
          },
          messages: [{ role: 'user', content: 'extract data' }],
        },
        { signal: new AbortController().signal },
      );

      expect(converse).toHaveBeenCalledOnce();
    });

    it('supports a predicate function instead of a static list', async () => {
      const { client, converse } = makeFakeBedrockClient('unused');
      const adapted = fromBedrock(client, {
        toolUseSupportedModels: (modelId) => modelId.startsWith('anthropic.'),
      });

      await expect(
        adapted.chat.completions.create(
          {
            model: 'amazon.titan-text',
            temperature: 0.2,
            max_tokens: 10,
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'Candidate', schema: { type: 'object' } },
            },
            messages: [{ role: 'user', content: 'extract data' }],
          },
          { signal: new AbortController().signal },
        ),
      ).rejects.toMatchObject({ name: 'LLMError', type: 'invalid_params' });

      expect(converse).not.toHaveBeenCalled();
    });

    it('proceeds normally and passes the model ID to a predicate that returns true', async () => {
      const { client, converse } = makeFakeBedrockClient('ok');
      const predicate = vi.fn((modelId: string) => modelId.startsWith('anthropic.'));
      const adapted = fromBedrock(client, { toolUseSupportedModels: predicate });

      await adapted.chat.completions.create(
        {
          model: 'anthropic.claude-test',
          temperature: 0.2,
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'Candidate', schema: { type: 'object' } },
          },
          messages: [{ role: 'user', content: 'extract data' }],
        },
        { signal: new AbortController().signal },
      );

      expect(predicate).toHaveBeenCalledWith('anthropic.claude-test');
      expect(converse).toHaveBeenCalledOnce();
    });

    it('does not preflight-check calls that are not json_schema, even with an allowlist configured', async () => {
      const { client, converse } = makeFakeBedrockClient('plain text reply');
      const adapted = fromBedrock(client, { toolUseSupportedModels: ['supported-model'] });

      const result = await adapted.chat.completions.create(
        {
          model: 'not-in-the-list',
          temperature: 0.2,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      );

      expect(converse).toHaveBeenCalledOnce();
      expect(at(result.choices ?? [], 0).message?.content).toBe('plain text reply');
    });

    it('skips the preflight check entirely when no toolUseSupportedModels is configured', async () => {
      const { client, converse } = makeFakeBedrockClient('ok');
      const adapted = fromBedrock(client);

      await adapted.chat.completions.create(
        {
          model: 'any-model',
          temperature: 0.2,
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'Candidate', schema: { type: 'object' } },
          },
          messages: [{ role: 'user', content: 'extract data' }],
        },
        { signal: new AbortController().signal },
      );

      expect(converse).toHaveBeenCalledOnce();
    });
  });
});

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
        ],
      },
      { role: 'user', content: [{ text: 'thanks, what about tomorrow?' }] },
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

    const sentMessages = converse.mock.calls[0]![0].messages;

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

describe('fromBedrock, native structured output', () => {
  const nativeModel = 'anthropic.claude-native-model';

  it('never uses the native path by default, so `tools` + `jsonSchema` is still rejected with no nativeStructuredOutputModels configured', async () => {
    const { client, converse } = makeFakeBedrockClient('unused');
    const adapted = fromBedrock(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: nativeModel,
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
      type: 'validation',
      message: expect.stringContaining(nativeModel),
    });

    expect(converse).not.toHaveBeenCalled();
  });

  it('throws a validation LLMError naming the model when combining `tools` with `jsonSchema` on a model not covered by nativeStructuredOutputModels', async () => {
    const { client, converse } = makeFakeBedrockClient('unused');
    const adapted = fromBedrock(client, { nativeStructuredOutputModels: ['some-other-model'] });

    await expect(
      adapted.chat.completions.create(
        {
          model: 'amazon.titan-text',
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
      type: 'validation',
      message: expect.stringContaining('amazon.titan-text'),
    });

    expect(converse).not.toHaveBeenCalled();
  });

  it('sends jsonSchema as outputConfig.textFormat alongside real tools, unmodified, on a model covered by nativeStructuredOutputModels', async () => {
    const { client, converse } = makeFakeBedrockClient('{"ok":true}');
    const adapted = fromBedrock(client, { nativeStructuredOutputModels: [nativeModel] });

    const result = await adapted.chat.completions.create(
      {
        model: nativeModel,
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

    const sentParams = at(converse.mock.calls, 0)[0];

    expect(sentParams.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: 'get_weather',
            description: 'weather',
            inputSchema: { json: { type: 'object' } },
          },
        },
      ],
      toolChoice: { auto: {} },
    });

    // Nested under structure.jsonSchema, schema JSON-encoded as a string,
    // matching the real Bedrock Converse API exactly; no strict field.
    expect(sentParams.outputConfig).toEqual({
      textFormat: {
        type: 'json_schema',
        structure: {
          jsonSchema: {
            schema: JSON.stringify({ type: 'object' }),
            name: 'Out',
            description: 'desc',
          },
        },
      },
    });

    expect(result.choices?.[0]?.message?.content).toBe('{"ok":true}');
  });

  it('sends jsonSchema alone as outputConfig.textFormat (not a forced tool call) on a covered model, even with no real tools present', async () => {
    const { client, converse } = makeFakeBedrockClient('{"name":"Ada"}');
    const adapted = fromBedrock(client, { nativeStructuredOutputModels: [nativeModel] });

    const result = await adapted.chat.completions.create(
      {
        model: nativeModel,
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'Candidate', schema: { type: 'object' } },
        },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(converse.mock.calls, 0)[0];

    expect(sentParams.toolConfig).toBeUndefined();
    expect(sentParams.outputConfig).toEqual({
      textFormat: {
        type: 'json_schema',
        structure: {
          jsonSchema: { schema: JSON.stringify({ type: 'object' }), name: 'Candidate' },
        },
      },
    });
    expect(result.choices?.[0]?.message?.content).toBe('{"name":"Ada"}');
  });

  it('still uses the legacy forced-tool-call path for jsonSchema alone on a non-covered model (regression)', async () => {
    const { client, converse } = makeFakeBedrockToolClient('Candidate', { name: 'Ada' });
    const adapted = fromBedrock(client);

    const result = await adapted.chat.completions.create(
      {
        model: 'amazon.titan-text',
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'Candidate', schema: { type: 'object' } },
        },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    const sentParams = at(converse.mock.calls, 0)[0];

    expect(sentParams.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: 'Candidate',
            description: undefined,
            inputSchema: { json: { type: 'object' } },
            strict: undefined,
          },
        },
      ],
      toolChoice: { tool: { name: 'Candidate' } },
    });
    expect(sentParams.outputConfig).toBeUndefined();
    expect(result.choices?.[0]?.message?.content).toBe(JSON.stringify({ name: 'Ada' }));
  });

  it('supports a predicate function instead of a static list for nativeStructuredOutputModels', async () => {
    const { client, converse } = makeFakeBedrockClient('{"ok":true}');
    const adapted = fromBedrock(client, {
      nativeStructuredOutputModels: (model) => model.startsWith('anthropic.claude-native-'),
    });

    await adapted.chat.completions.create(
      {
        model: nativeModel,
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

    const sentParams = at(converse.mock.calls, 0)[0];

    expect(sentParams.outputConfig).toBeDefined();
    expect(sentParams.toolConfig?.tools).toEqual([
      {
        toolSpec: {
          name: 'get_weather',
          description: 'weather',
          inputSchema: { json: { type: 'object' } },
        },
      },
    ]);
  });

  it('tools alone still work unmodified on a nativeStructuredOutputModels-covered model (regression)', async () => {
    const { client, converse } = makeFakeBedrockToolClient('get_weather', { city: 'NYC' });
    const adapted = fromBedrock(client, { nativeStructuredOutputModels: [nativeModel] });

    const result = await adapted.chat.completions.create(
      {
        model: nativeModel,
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

    const sentParams = at(converse.mock.calls, 0)[0];

    expect(sentParams.outputConfig).toBeUndefined();
    expect(result.choices?.[0]?.message?.tool_calls).toEqual([
      {
        id: expect.any(String),
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
      },
    ]);
  });

  it("this adapter's toolUseSupportedModels preflight still runs independently for legacy jsonSchema calls, unaffected by nativeStructuredOutputModels", async () => {
    const { client, converse } = makeFakeBedrockClient('unused');
    const adapted = fromBedrock(client, { toolUseSupportedModels: ['supported-model'] });

    await expect(
      adapted.chat.completions.create(
        {
          model: 'unsupported-model',
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'Candidate', schema: { type: 'object' } },
          },
          messages: [{ role: 'user', content: 'extract data' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ name: 'LLMError', type: 'invalid_params' });

    expect(converse).not.toHaveBeenCalled();
  });

  it('toolUseSupportedModels preflight also runs on the native path when real tools are sent alongside outputConfig (closes the gap where native structured output skipped it)', async () => {
    const { client, converse } = makeFakeBedrockClient('unused');
    const adapted = fromBedrock(client, {
      nativeStructuredOutputModels: [nativeModel],
      toolUseSupportedModels: ['some-other-model'],
    });

    await expect(
      adapted.chat.completions.create(
        {
          model: nativeModel,
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
    ).rejects.toMatchObject({ name: 'LLMError', type: 'invalid_params' });

    expect(converse).not.toHaveBeenCalled();
  });

  it('toolUseSupportedModels preflight does not run on the native path when no real tools are sent (native structured output alone needs no tool-use support)', async () => {
    const { client, converse } = makeFakeBedrockClient('{"ok":true}');
    const adapted = fromBedrock(client, {
      nativeStructuredOutputModels: [nativeModel],
      toolUseSupportedModels: ['some-other-model'],
    });

    await adapted.chat.completions.create(
      {
        model: nativeModel,
        max_tokens: 10,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'Out', schema: { type: 'object' } },
        },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { signal: new AbortController().signal },
    );

    expect(converse).toHaveBeenCalledOnce();
  });

  it(
    'streams a native model correctly with real tools present: outputConfig is sent, text ' +
      'surfaces as text-delta, and the concurrent real tool call surfaces as tool_call_delta',
    async () => {
      // Small local streaming fake, matching bedrock.stream.unit.test.ts's
      // fakeBedrockStream/makeFakeStreamingBedrockClient shape, kept local
      // here since this is the only streaming test in this file (every
      // other streaming case lives in bedrock.stream.unit.test.ts; this
      // one belongs alongside the other native-structured-output cases
      // instead, since it's specifically about the interaction between
      // `nativeStructuredOutputModels` and `createStream`, not streaming
      // mechanics in general).
      function fakeStream(events: unknown[]): AsyncIterable<unknown> {
        return {
          [Symbol.asyncIterator]() {
            let index = 0;
            return {
              async next() {
                if (index >= events.length) return { done: true, value: undefined };
                return { done: false, value: events[index++] };
              },
            };
          },
        };
      }

      const converse = vi.fn<BedrockConverseClient['converse']>(async () => ({}));
      const converseStream = vi.fn(async (_params: unknown, _options: unknown) => ({
        stream: fakeStream([
          { contentBlockStart: { contentBlockIndex: 0, start: {} } },
          { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '{"ok":true}' } } },
          { contentBlockStop: { contentBlockIndex: 0 } },
          {
            contentBlockStart: {
              contentBlockIndex: 1,
              start: { toolUse: { toolUseId: 'call_1', name: 'get_weather' } },
            },
          },
          {
            contentBlockDelta: {
              contentBlockIndex: 1,
              delta: { toolUse: { input: '{"city":"NYC"}' } },
            },
          },
          { contentBlockStop: { contentBlockIndex: 1 } },
          { metadata: { usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 } } },
        ]),
      }));

      const adapted = fromBedrock(
        { converse, converseStream } as unknown as BedrockConverseClient,
        { nativeStructuredOutputModels: [nativeModel] },
      );

      const chunks: unknown[] = [];
      for await (const chunk of adapted.chat.completions.createStream!(
        {
          model: nativeModel,
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
      )) {
        chunks.push(chunk);
      }

      const [sentParams] = converseStream.mock.calls[0] as [Record<string, unknown>, unknown];
      expect(sentParams.outputConfig).toEqual({
        textFormat: {
          type: 'json_schema',
          structure: { jsonSchema: { schema: JSON.stringify({ type: 'object' }), name: 'Out' } },
        },
      });

      expect(chunks).toEqual([
        { type: 'text-delta', delta: '{"ok":true}' },
        { type: 'tool_call_delta', index: 1, id: 'call_1', name: 'get_weather' },
        { type: 'tool_call_delta', index: 1, argumentsDelta: '{"city":"NYC"}' },
        { type: 'usage', usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } },
      ]);
    },
  );

  describe('thinking + forced tool_choice (Claude models)', () => {
    it('throws invalid_params locally, without calling the client, when budget_tokens is set alongside a forced single-tool choice', async () => {
      const { client, converse } = makeFakeBedrockClient('unused');
      const adapted = fromBedrock(client);

      await expect(
        adapted.chat.completions.create(
          {
            model: 'anthropic.claude-test',
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

      expect(converse).not.toHaveBeenCalled();
    });

    it('throws invalid_params when reasoning_effort is set alongside tool_choice: "required"', async () => {
      const { client, converse } = makeFakeBedrockClient('unused');
      const adapted = fromBedrock(client);

      await expect(
        adapted.chat.completions.create(
          {
            model: 'anthropic.claude-test',
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

      expect(converse).not.toHaveBeenCalled();
    });

    it('does not throw, and sends thinking, when tool_choice is left at auto', async () => {
      const { client, converse } = makeFakeBedrockClient('ok');
      const adapted = fromBedrock(client);

      await adapted.chat.completions.create(
        {
          model: 'anthropic.claude-test',
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

      const [sentParams] = at(converse.mock.calls, 0) as [Record<string, unknown>, unknown];
      expect(sentParams.additionalModelRequestFields).toEqual({
        thinking: { type: 'enabled', budget_tokens: 1024 },
      });
    });

    it('is unaffected on a non-Claude model (thinking never applies there in the first place)', async () => {
      const { client, converse } = makeFakeBedrockClient('ok');
      const adapted = fromBedrock(client);

      await adapted.chat.completions.create(
        {
          model: 'eu.amazon.nova-lite-v1:0',
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
      );

      expect(converse).toHaveBeenCalledOnce();
    });
  });
});
