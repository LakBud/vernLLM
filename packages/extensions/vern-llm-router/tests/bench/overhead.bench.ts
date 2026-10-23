import { VernLLM } from 'vern-llm';
import { bench, describe } from 'vitest';

import { routerMiddleware } from '../../src/index.js';
import { targetChain } from '../helpers.js';

// `pnpm bench` for a quick look at the cost of each strategy. The number CI guards is the one from
// `pnpm bench:check`, which runs against the built package.

const call = { userContent: 'hi', jsonMode: false };

const make = (middleware: ReturnType<typeof routerMiddleware>[]) =>
  new VernLLM({ ...targetChain().options, middleware });

describe('a call with a fake client', () => {
  const plain = make([]);
  const ordered = make([routerMiddleware({ logger: 'silent', routes: [{ name: 'all' }] })]);
  const weighted = make([
    routerMiddleware({
      logger: 'silent',
      routes: [{ name: 'ab', strategy: { type: 'weighted', weights: { primary: 1, b: 2, c: 3 } } }],
    }),
  ]);

  bench('no middleware', async () => {
    await plain.call(call);
  });
  bench('router, ordered', async () => {
    await ordered.call(call);
  });
  bench('router, weighted', async () => {
    await weighted.call(call);
  });
});
