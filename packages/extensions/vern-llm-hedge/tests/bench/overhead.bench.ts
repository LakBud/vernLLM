import { VernLLM } from 'vern-llm';
import { bench, describe } from 'vitest';

import { hedgeMiddleware } from '../../src/index.js';
import { targetChain } from '../helpers.js';

// `pnpm bench` for a quick look at the cost of each path. The number CI guards is the one from
// `pnpm bench:check`, which runs against the built package.

const call = { userContent: 'hi', jsonMode: false as const };

const make = (middleware: ReturnType<typeof hedgeMiddleware>[]) =>
  new VernLLM({ ...targetChain().options, middleware });

describe('a call with a fake client', () => {
  const plain = make([]);
  const skipped = make([
    hedgeMiddleware({ logger: 'silent', stats: { quantile: () => undefined } }),
  ]);
  const inTime = make([hedgeMiddleware({ logger: 'silent', delay: 60_000 })]);

  bench('no middleware', async () => {
    await plain.call(call);
  });
  bench('hedge, skipped', async () => {
    await skipped.call(call);
  });
  bench('hedge, answered within the delay', async () => {
    await inTime.call(call);
  });
});
