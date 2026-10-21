import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { usageMiddleware, type UsageMiddlewareOptions } from '../../src/index.js';
import { captureLogger, costProbe, createMockClient, daysAgo, textResponse } from '../helpers.js';

// 60 x 2,000 + 40 x 10,000 = 520,000 nano dollars from the table, against $0.01 reported.
const tokens = { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 };
const prices = { 'gpt-6-sol': { input: 2, output: 10 } };
const call = { userContent: 'hi', jsonMode: false as const, context: { tenantId: 'acme' } };

function setup(
  script: Parameters<typeof createMockClient>[0],
  extra: Partial<UsageMiddlewareOptions> = {},
  model = 'gpt-6-sol',
  maxRetries = 0,
) {
  const probe = costProbe();
  const usage = usageMiddleware({
    prices,
    pricesAsOf: daysAgo(1),
    attribute: ['tenantId'],
    logger: 'silent',
    ...extra,
  });
  const llm = new VernLLM({
    client: createMockClient(script).client,
    model,
    maxRetries,
    baseDelayMs: 1,
    logger: 'silent',
    defaultMaxTokens: 50,
    detectSoftFailure: (result) =>
      result === 'bad' ? ('soft_failure_detected' as const) : undefined,
    middleware: [probe.middleware, usage],
  });
  return { llm, usage, fields: probe.fields };
}

describe('provider reported cost', () => {
  it('beats the price table, and is named reported', async () => {
    const { llm, fields } = setup([textResponse('ok', { ...tokens, cost: 0.01 })]);

    await llm.call(call);

    expect(fields).toEqual([{ estimatedCostUsd: 0.01, wastedUsd: 0, costSource: 'reported' }]);
  });

  it('prices a model the table has never heard of, without an unpriced warning', async () => {
    const { logger, warnings } = captureLogger();
    const { llm, fields, usage } = setup(
      [textResponse('ok', { ...tokens, cost: 0.01 })],
      { logger },
      'mystery',
    );

    await llm.call(call);

    expect(fields[0]).toMatchObject({ estimatedCostUsd: 0.01, costSource: 'reported' });
    expect(warnings()).toEqual([]);
    expect(usage.totals().bySource).toEqual({ reported: 1, table: 0, unpriced: 0 });
  });

  it('accepts a cost of zero, as a free model reports', async () => {
    const { llm, fields } = setup([textResponse('ok', { ...tokens, cost: 0 })]);

    await llm.call(call);

    expect(fields[0]).toMatchObject({ estimatedCostUsd: 0, costSource: 'reported' });
  });

  it.each([-1, Number.NaN])('falls back to the table when the cost is %s', async (cost) => {
    const { llm, fields } = setup([textResponse('ok', { ...tokens, cost })]);

    await llm.call(call);

    expect(fields[0]).toMatchObject({ estimatedCostUsd: 0.00052, costSource: 'table' });
  });

  it('counts a rejected attempt as wasted at its reported cost, and the call as table priced when mixed', async () => {
    const { llm, fields } = setup(
      [textResponse('bad', { ...tokens, cost: 0.004 }), textResponse('good', tokens)],
      {},
      'gpt-6-sol',
      1,
    );

    await llm.call(call);

    expect(fields).toEqual([{ estimatedCostUsd: 0.00452, wastedUsd: 0.004, costSource: 'table' }]);
  });

  it('is what a dollar budget counts', async () => {
    const { llm } = setup([textResponse('ok', { ...tokens, cost: 0.01 })], {
      budgets: [{ key: 'tenantId', limitUsd: 0.0103, per: 'day' }],
    });

    await llm.call(call);

    await expect(llm.call(call)).rejects.toMatchObject({ code: 'budget_exceeded' });
  });
});
