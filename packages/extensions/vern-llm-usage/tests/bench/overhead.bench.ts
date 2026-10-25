import { VernLLM } from 'vern-llm';
import { bench, describe } from 'vitest';

import { usageMiddleware, type UsageBudget } from '../../src/index.js';
import { createMockClient, daysAgo, textResponse } from '../helpers.js';

// `pnpm bench` for a quick look at the cost of each setup. The number CI guards is the one from
// `pnpm bench:check`, which runs against the built package.

const spent = { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 };
const prices = { 'a-model': { input: 2, output: 10 } };
const call = {
  userContent: 'hi',
  jsonMode: false as const,
  context: { tenantId: 'acme', team: 'x' },
};

const make = (budgets?: UsageBudget[]) => {
  const { client } = createMockClient([textResponse('ok', spent)]);
  const middleware = budgets
    ? [
        usageMiddleware({
          prices,
          pricesAsOf: daysAgo(0),
          attribute: ['tenantId', 'team'],
          budgets,
          logger: 'silent',
        }),
      ]
    : [];
  return new VernLLM({
    client,
    model: 'a-model',
    maxRetries: 0,
    logger: 'silent',
    defaultMaxTokens: 50,
    middleware,
  });
};

describe('a call with a fake client', () => {
  const plain = make();
  const one = make([{ key: 'tenantId', limitTokens: 1e12, per: 'day' }]);
  const three = make([
    { key: 'tenantId', limitUsd: 1e6, per: 'day' },
    { key: 'tenantId', limitTokens: 1e12, per: 'month' },
    { key: 'team', limitUsd: 1e6, per: 'day' },
  ]);

  bench('no middleware', async () => {
    await plain.call(call);
  });
  bench('usage, one token budget', async () => {
    await one.call(call);
  });
  bench('usage, three budgets with cost', async () => {
    await three.call(call);
  });
});
