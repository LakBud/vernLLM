import { VernLLM } from 'vern-llm';
import { bench, describe } from 'vitest';

import { policyMiddleware } from '../../src/index.js';
import { targetChain } from '../helpers.js';

// `pnpm bench` for a quick look at the cost of each strategy. The number CI guards is the one from
// `pnpm bench:check`, which runs against the built package.

const call = { userContent: 'hi', jsonMode: false as const, context: { tier: 'vip' } };

const make = (middleware: ReturnType<typeof policyMiddleware>[]) =>
  new VernLLM({ ...targetChain().options, middleware });

describe('a call with a fake client', () => {
  const plain = make([]);
  const forbid = make([
    policyMiddleware({ logger: 'silent', rules: [{ id: 'no-b', forbid: { name: 'b' } }] }),
  ]);
  const flags = make([
    policyMiddleware({
      logger: 'silent',
      rules: [{ id: 'pii', set: { logContent: false }, when: { context: { tier: 'vip' } } }],
    }),
  ]);

  bench('no middleware', async () => {
    await plain.call(call);
  });
  bench('policy, one forbid', async () => {
    await forbid.call(call);
  });
  bench('policy, flags', async () => {
    await flags.call(call);
  });
});
