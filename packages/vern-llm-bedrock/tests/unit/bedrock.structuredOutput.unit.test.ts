import { describe, it, expect, vi } from 'vitest';

import { fromBedrock } from '../../src/index.js';
import { at, stubbedClient, type ConverseHandler } from '../helpers.js';

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

describe('fromBedrock, structured output', () => {
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

  it('throws a validation LLMError when json_schema.name is empty or whitespace-only', async () => {
    const { client, converse } = makeFakeBedrockClient('unused');
    const adapted = fromBedrock(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'anthropic.claude-test',
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

  it('throws a validation LLMError when json_schema mode is forced but Bedrock never returns the matching toolUse block', async () => {
    const { client } = makeFakeBedrockClient('plain text instead of a tool call');
    const adapted = fromBedrock(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'anthropic.claude-test',
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'Candidate', schema: { type: 'object' } },
          },
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ name: 'LLMError', type: 'validation' });
  });

  it("throws validation when the forced tool's input is null", async () => {
    const { client } = makeFakeBedrockToolClient('Candidate', null);
    const adapted = fromBedrock(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'anthropic.claude-test',
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
      name: 'LLMError',
      type: 'validation',
      message: expect.stringContaining('Expected an object'),
    });
  });

  it("throws validation when the forced tool's input is a bare string", async () => {
    const { client } = makeFakeBedrockToolClient('Candidate', 'not an object');
    const adapted = fromBedrock(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'anthropic.claude-test',
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
      name: 'LLMError',
      type: 'validation',
      message: expect.stringContaining('Expected an object'),
    });
  });

  it("throws validation when the forced tool's input is an array", async () => {
    const { client } = makeFakeBedrockToolClient('Candidate', ['not', 'an', 'object']);
    const adapted = fromBedrock(client);

    await expect(
      adapted.chat.completions.create(
        {
          model: 'anthropic.claude-test',
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
      name: 'LLMError',
      type: 'validation',
      message: expect.stringContaining('Expected an object'),
    });
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

  it('propagates Bedrock errors as-is for json_schema calls, without reclassification', async () => {
    // Converse rejects tool-use for an unsupported model. VernLLM doesn't
    // attempt to guess this from the error text (see the fromBedrock doc
    // comment); the raw error should surface unchanged.
    const error = new Error('ValidationException: tool use is not supported for this model');

    const converse = vi.fn<ConverseHandler>(async () => {
      throw error;
    });

    const adapted = fromBedrock(stubbedClient({ converse }));

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
      const { client, converse } = makeFakeBedrockToolClient('Candidate', { ok: true });
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
      const { client, converse } = makeFakeBedrockToolClient('Candidate', { ok: true });
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
      const { client, converse } = makeFakeBedrockToolClient('Candidate', { ok: true });
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
