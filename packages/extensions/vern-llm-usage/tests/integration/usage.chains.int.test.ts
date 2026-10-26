import { VernLLM, type VernLLMMiddleware } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { usageMiddleware } from '../../src/index.js';
import { costProbe, createMockClient, daysAgo, textResponse } from '../helpers.js';

const prices = { 'gpt-6-sol': { input: 2, output: 10 }, cheap: { input: 1, output: 1 } };

// 1,000 x 2,000 + 100 x 10,000 nano dollars at the gpt-6-sol rates: $0.003.
const slow = { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 };
// 2,000 x 1,000 + 200 x 1,000 nano dollars at the cheap rates: $0.0022.

/** Runs the call twice at once and keeps the answer that is `keep`, like any layer using reruns. */
function twoChains(keep: 0 | 1): VernLLMMiddleware {
  return {
    name: 'two-chains',
    reruns: true,
    position: 10,
    wrap: async (_request, next) => {
      const first = next();
      const second = next.again!({});
      const [a, b] = await Promise.all([first, second]);
      return keep === 0 ? a : b;
    },
  };
}

function setup(keep: 0 | 1) {
  const probe = costProbe();
  const usage = usageMiddleware({ prices, pricesAsOf: daysAgo(1), logger: 'silent' });
  const main = createMockClient([textResponse('main', slow)]);
  const llm = new VernLLM({
    client: main.client,
    model: 'gpt-6-sol',
    maxRetries: 0,
    logger: 'silent',
    middleware: [probe.middleware, usage, twoChains(keep)],
  });
  return { llm, usage, fields: probe.fields };
}

const call = { userContent: 'hi', jsonMode: false as const };

describe('calls with more than one chain', () => {
  it('counts both chains in the cost, and reports the spend of the chain that was not returned', async () => {
    const { llm, fields } = setup(0);

    await llm.call(call);

    // Two identical chains at $0.003: the second was not returned.
    expect(fields).toEqual([
      { estimatedCostUsd: 0.006, wastedUsd: 0, unkeptUsd: 0.003, costSource: 'table' },
    ]);
  });

  it('reports the main chain as the unkept one when the other chain was returned', async () => {
    const { llm, fields } = setup(1);

    await llm.call(call);

    expect(fields[0]).toMatchObject({ estimatedCostUsd: 0.006, unkeptUsd: 0.003 });
  });

  it('adds the unkept spend to the totals', async () => {
    const { llm, usage } = setup(0);

    await llm.call(call);

    expect(usage.totals()).toMatchObject({ estimatedCostUsd: 0.006, unkeptUsd: 0.003, calls: 1 });
  });

  it('leaves a call with one chain without the field', async () => {
    const probe = costProbe();
    const llm = new VernLLM({
      client: createMockClient([textResponse('x', slow)]).client,
      model: 'gpt-6-sol',
      maxRetries: 0,
      logger: 'silent',
      middleware: [
        probe.middleware,
        usageMiddleware({ prices, pricesAsOf: daysAgo(1), logger: 'silent' }),
      ],
    });

    await llm.call(call);

    expect(probe.fields[0]).not.toHaveProperty('unkeptUsd');
  });
});
