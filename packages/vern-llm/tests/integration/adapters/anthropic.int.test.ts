import { describe, expect, it, vi } from 'vitest';

import { fromAnthropic } from '../../../src/adapters/anthropic.js';

describe('Anthropic adapter integration', () => {
  it('maps Anthropic messages API into LLMClient format', async () => {
    const anthropic = {
      messages: {
        create: vi.fn(async () => ({
          content: [
            {
              type: 'text',
              text: '{"answer":"ok"}',
            },
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 8,
          },
        })),
      },
    };

    const client = fromAnthropic(anthropic);

    const result = await client.chat.completions.create(
      {
        model: 'claude-test',
        temperature: 0.2,
        max_tokens: 100,
        messages: [
          {
            role: 'system',
            content: 'Return JSON',
          },
          {
            role: 'user',
            content: 'hello',
          },
        ],
        response_format: {
          type: 'json_object',
        },
      },
      {
        signal: new AbortController().signal,
      },
    );

    expect(result.choices?.[0]?.message?.content).toBe('{"answer":"ok"}');

    expect(result.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
    });

    expect(anthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-test',
        max_tokens: 100,
        system: expect.stringContaining('JSON'),
      }),
      expect.anything(),
    );
  });

  it('sends prior assistant turns through instead of dropping them', async () => {
    const anthropic = {
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: 'text', text: 'About 2.1 million.' }],
          usage: { input_tokens: 20, output_tokens: 6 },
        })),
      },
    };

    const client = fromAnthropic(anthropic);

    await client.chat.completions.create(
      {
        model: 'claude-test',
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

    expect(anthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'user', content: "What's the capital of France?" },
          { role: 'assistant', content: 'Paris.' },
          { role: 'user', content: "What's its population?" },
        ],
      }),
      expect.anything(),
    );
  });

  it('forces tool-use for json_schema structured output instead of prompt injection', async () => {
    const anthropic = {
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: 'tool_use', name: 'Summary', input: { ok: true } }],
          usage: { input_tokens: 14, output_tokens: 4 },
        })),
      },
    };

    const client = fromAnthropic(anthropic);

    const result = await client.chat.completions.create(
      {
        model: 'claude-test',
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

    expect(anthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [expect.objectContaining({ name: 'Summary' })],
        tool_choice: { type: 'tool', name: 'Summary' },
      }),
      expect.anything(),
    );
  });
});
