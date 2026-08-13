import { describe, expect, it } from 'vitest';

import {
  fromOpenAICompatible,
  fromGroq,
  fromMistral,
} from '../../../../src/adapters/openaiCompatible.js';

describe('OpenAI compatible adapters', () => {
  it('passes through compatible clients', async () => {
    const makeOriginal = (baseURL?: string) => ({
      baseURL,
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
    });

    const cases: Array<[typeof fromOpenAICompatible, ReturnType<typeof makeOriginal>]> = [
      [fromOpenAICompatible, makeOriginal(undefined)],
      [fromGroq, makeOriginal('https://api.groq.com/openai/v1')],
      [fromMistral, makeOriginal('https://api.mistral.ai/v1')],
    ];

    for (const [adapter, original] of cases) {
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
