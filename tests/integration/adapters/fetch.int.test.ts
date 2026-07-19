import { describe, expect, it, vi } from 'vitest';
import { fromFetch } from '../../../src/adapters/fetch.js';

describe('Fetch adapter integration', () => {
  it('maps HTTP provider responses into LLMClient format', async () => {

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          response: 'hello',
        }),
      })),
    );


    const client = fromFetch({
      url: 'https://example.com/chat',

      mapRequest: (params) => ({
        prompt: params.messages,
      }),

      mapResponse: () => ({
        content: '{"ok":true}',
        usage: {
          promptTokens: 3,
          completionTokens: 4,
          totalTokens: 7,
        },
      }),
    });


    const result =
      await client.chat.completions.create(
        {
          model: 'custom',
          temperature: 0,
          max_tokens: 10,
          messages: [
            {
              role: 'user',
              content: 'hi',
            },
          ],
        },
        {
          signal: new AbortController().signal,
        },
      );


    expect(result.choices?.[0]?.message?.content)
      .toBe('{"ok":true}');

    expect(result.usage?.total_tokens)
      .toBe(7);
  });
});