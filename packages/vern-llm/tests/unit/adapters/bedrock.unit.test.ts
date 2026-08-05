import { describe, it, expect, vi } from 'vitest';

import { type BedrockConverseClient, fromBedrock } from '../../../src/adapters/index.js';
import { at } from '../../helpers.js';

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

  it('throws a validation LLMError for an unsupported image mimeType', async () => {
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
    ).rejects.toMatchObject({ name: 'LLMError', type: 'validation' });
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

  it('emulates JSON mode via a system-prompt instruction, appended to any existing system message', async () => {
    const { client, converse } = makeFakeBedrockClient('{}');
    const adapted = fromBedrock(client);

    await adapted.chat.completions.create(
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
    );

    const system = at(converse.mock.calls, 0)[0].system as Array<{ text: string }>;
    expect(at(system, 0).text).toBe('be brief');
    expect(at(system, 1).text).toMatch(/valid JSON only/i);
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
    it('rejects with a validation LLMError, without calling converse, when the model is not in the allowlist', async () => {
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
      ).rejects.toMatchObject({ name: 'LLMError', type: 'validation' });

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
      ).rejects.toMatchObject({ name: 'LLMError', type: 'validation' });

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

describe('fromBedrock — tools', () => {
  const weatherTool = {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Gets the weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  };

  it('throws a clear validation error for toolChoice: none, instead of silently falling back to auto', async () => {
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
    ).rejects.toMatchObject({ type: 'validation' });
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
        messages: [{ role: 'user', content: 'weather in Oslo?' }],
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
    const { client } = makeFakeBedrockToolClient('get_weather', { city: 'Oslo' });
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
        function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Oslo' }) },
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
                function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Oslo' }) },
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
          { toolUse: { toolUseId: 'call_1', name: 'get_weather', input: { city: 'Oslo' } } },
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
                function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Oslo' }) },
              },
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'get_time', arguments: JSON.stringify({ city: 'Oslo' }) },
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
});
