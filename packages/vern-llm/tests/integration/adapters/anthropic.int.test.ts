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
});
