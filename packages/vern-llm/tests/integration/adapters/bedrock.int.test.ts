import { describe, expect, it, vi } from 'vitest';

import { fromBedrock } from '../../../src/adapters/bedrock.js';

describe('Bedrock adapter integration', () => {
  it('maps the Converse API into LLMClient format', async () => {
    const bedrock = {
      converse: vi.fn(async () => ({
        output: { message: { content: [{ text: '{"answer":"ok"}' }] } },
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      })),
    };

    const client = fromBedrock(bedrock);

    const result = await client.chat.completions.create(
      {
        model: 'anthropic.claude-test',
        temperature: 0.2,
        max_tokens: 100,
        messages: [
          { role: 'system', content: 'Return JSON' },
          { role: 'user', content: 'hello' },
        ],
        response_format: { type: 'json_object' },
      },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.content).toBe('{"answer":"ok"}');

    expect(result.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
    });

    expect(bedrock.converse).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'anthropic.claude-test',
        system: expect.arrayContaining([expect.objectContaining({ text: 'Return JSON' })]),
      }),
      expect.anything(),
    );
  });

  it('sends prior assistant turns through instead of dropping them', async () => {
    const bedrock = {
      converse: vi.fn(async () => ({
        output: { message: { content: [{ text: 'About 2.1 million.' }] } },
        usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26 },
      })),
    };

    const client = fromBedrock(bedrock);

    await client.chat.completions.create(
      {
        model: 'anthropic.claude-test',
        temperature: 0.2,
        max_tokens: 100,
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: "What's the capital of France?" },
          { role: 'assistant', content: 'Paris.' },
          { role: 'user', content: "What's its population?" },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(bedrock.converse).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'user', content: [{ text: "What's the capital of France?" }] },
          { role: 'assistant', content: [{ text: 'Paris.' }] },
          { role: 'user', content: [{ text: "What's its population?" }] },
        ],
      }),
      expect.anything(),
    );
  });

  it('forces tool-use via toolConfig for json_schema structured output instead of prompt injection', async () => {
    const bedrock = {
      converse: vi.fn(async () => ({
        output: { message: { content: [{ toolUse: { name: 'Summary', input: { ok: true } } }] } },
        usage: { inputTokens: 14, outputTokens: 4, totalTokens: 18 },
      })),
    };

    const client = fromBedrock(bedrock);

    const result = await client.chat.completions.create(
      {
        model: 'anthropic.claude-test',
        temperature: 0.2,
        max_tokens: 100,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'Summary', schema: { type: 'object' } },
        },
        messages: [{ role: 'user', content: 'hello' }],
      },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.content).toBe(JSON.stringify({ ok: true }));

    expect(bedrock.converse).toHaveBeenCalledWith(
      expect.objectContaining({
        toolConfig: expect.objectContaining({
          tools: [
            expect.objectContaining({ toolSpec: expect.objectContaining({ name: 'Summary' }) }),
          ],
          toolChoice: { tool: { name: 'Summary' } },
        }),
      }),
      expect.anything(),
    );
  });

  it('passes multimodal user content into Bedrock Converse image blocks', async () => {
    const bedrock = {
      converse: vi.fn(async () => ({
        output: { message: { content: [{ text: 'I see an image.' }] } },
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      })),
    };

    const client = fromBedrock(bedrock);

    const result = await client.chat.completions.create(
      {
        model: 'anthropic.claude-test',
        temperature: 0.2,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: "What's in this image?" },
              { type: 'image', data: 'ZmFrZWJhc2U2NA==', mimeType: 'image/png' },
            ],
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(result.choices?.[0]?.message?.content).toBe('I see an image.');

    expect(bedrock.converse).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: 'user',
            content: [
              { text: "What's in this image?" },
              {
                image: {
                  format: 'png',
                  source: {
                    bytes: new Uint8Array(Buffer.from('ZmFrZWJhc2U2NA==', 'base64')),
                  },
                },
              },
            ],
          },
        ],
      }),
      expect.anything(),
    );
  });

  it('rejects nameless toolUse blocks with a validation error', async () => {
    const bedrock = {
      converse: vi.fn(async () => ({
        output: {
          message: {
            content: [
              {
                toolUse: {
                  input: { city: 'New York' },
                },
              },
            ],
          },
        },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      })),
    };

    const client = fromBedrock(bedrock);

    await expect(
      client.chat.completions.create(
        {
          model: 'anthropic.claude-test',
          temperature: 0.2,
          max_tokens: 100,
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Gets weather',
                parameters: {
                  type: 'object',
                  properties: {
                    city: { type: 'string' },
                  },
                },
              },
            },
          ],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      type: 'validation',
      message: expect.stringContaining('toolUse block without a name'),
    });
  });

  it('maps tool error results into Bedrock Converse toolResult status', async () => {
    const bedrock = {
      converse: vi.fn(async () => ({
        output: { message: { content: [{ text: 'ok' }] } },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      })),
    };

    const client = fromBedrock(bedrock);

    await client.chat.completions.create(
      {
        model: 'anthropic.claude-test',
        temperature: 0.2,
        max_tokens: 100,
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: JSON.stringify({ city: 'New York' }),
                },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            content: 'weather lookup failed',
            is_error: true,
          },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(bedrock.converse).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: 'assistant',
            content: [
              expect.objectContaining({
                toolUse: {
                  toolUseId: 'call_1',
                  name: 'get_weather',
                  input: { city: 'New York' },
                },
              }),
            ],
          }),
          {
            role: 'user',
            content: [
              {
                toolResult: {
                  toolUseId: 'call_1',
                  content: [{ text: 'weather lookup failed' }],
                  status: 'error',
                },
              },
            ],
          },
        ],
      }),
      expect.anything(),
    );
  });
});
