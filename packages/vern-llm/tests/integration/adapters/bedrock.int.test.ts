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
});
