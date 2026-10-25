import { bench, describe } from 'vitest';

import { fromBedrock } from '../../src/index.js';
import { fakeStream, stubbedClient } from '../helpers.js';

// `pnpm bench` for a quick look at the cost of each path. The number CI guards is the one from
// `pnpm bench:check`, which runs against the built package.

const signal = new AbortController().signal;
const params = {
  model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  max_tokens: 100,
  messages: [
    { role: 'system' as const, content: 'Be brief' },
    { role: 'user' as const, content: 'hello' },
  ],
};

describe('the adapter with a stubbed Bedrock client', () => {
  const client = fromBedrock(
    stubbedClient({
      converse: async () => ({
        output: { message: { content: [{ text: 'hello' }] } },
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      }),
      converseStream: async () => ({
        stream: fakeStream([
          { messageStart: { role: 'assistant' } },
          { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hel' } } },
          { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'lo' } } },
          { contentBlockStop: { contentBlockIndex: 0 } },
          { messageStop: { stopReason: 'end_turn' } },
        ]),
      }),
    }),
  );

  bench('text answer', async () => {
    await client.chat.completions.create(params, { signal });
  });
  bench('streamed text', async () => {
    for await (const chunk of client.chat.completions.createStream!(params, { signal })) {
      void chunk;
    }
  });
});
