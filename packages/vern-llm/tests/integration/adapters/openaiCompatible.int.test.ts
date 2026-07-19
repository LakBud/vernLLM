import { describe, expect, it } from 'vitest';

import {
  fromOpenAICompatible,
  fromGroq,
  fromMistral,
} from '../../../src/adapters/openaiCompatible.js';

describe('OpenAI compatible adapters', () => {
  it('passes through compatible clients', async () => {
    const original = {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: 'ok',
                },
              },
            ],
          }),
        },
      },
    };

    for (const adapter of [fromOpenAICompatible, fromGroq, fromMistral]) {
      const client = adapter(original);

      const result = await client.chat.completions.create(
        {
          model: 'test',
          temperature: 0,
          max_tokens: 10,
          messages: [],
        },
        {
          signal: new AbortController().signal,
        },
      );

      expect(result.choices?.[0]?.message?.content).toBe('ok');
    }
  });
});
