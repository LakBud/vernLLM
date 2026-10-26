import { VernLLM } from 'vern-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usageMiddleware, type UsageMiddlewareOptions } from '../../src/index.js';
import { captureLogger, createMockClient, daysAgo, textResponse } from '../helpers.js';

const prices = { 'gpt-6-sol': { input: 2, output: 10 }, cheap: { input: 1, output: 1 } };
// 60 x 2,000 + 40 x 10,000 = 520,000 nano dollars at the gpt-6-sol rates.
const spent = {
  prompt_tokens: 60,
  completion_tokens: 40,
  total_tokens: 100,
  prompt_tokens_details: { cached_tokens: 10 },
  completion_tokens_details: { reasoning_tokens: 5 },
};
const call = { userContent: 'hi', jsonMode: false as const };

function setup(
  script: Parameters<typeof createMockClient>[0] = [textResponse('ok', spent)],
  extra: Partial<UsageMiddlewareOptions> = {},
  model = 'gpt-6-sol',
) {
  const usage = usageMiddleware({
    prices,
    pricesAsOf: daysAgo(1),
    attribute: ['tenantId', 'feature'],
    logger: 'silent',
    ...extra,
  });
  const llm = new VernLLM({
    client: createMockClient(script).client,
    model,
    maxRetries: 0,
    logger: 'silent',
    defaultMaxTokens: 50,
    middleware: [usage],
  });
  return { llm, usage };
}

const as = (tenantId: string, feature = 'chat') => ({ ...call, context: { tenantId, feature } });

afterEach(() => {
  vi.useRealTimers();
});

describe('totals', () => {
  it('sums cost, calls and token kinds for the current day', async () => {
    const { llm, usage } = setup();

    await llm.call(as('acme'));
    await llm.call(as('acme'));

    expect(usage.totals()).toEqual({
      estimatedCostUsd: expect.closeTo(0.00104, 12),
      wastedUsd: 0,
      unkeptUsd: 0,
      estimatedSavedUsd: 0,
      calls: 2,
      bySource: { reported: 0, table: 2, unpriced: 0 },
      tokens: { input: 120, output: 80, cacheRead: 20, cacheWrite: 0, reasoning: 10 },
      cacheHits: 0,
      joins: 0,
      unknownSpendCalls: 0,
    });
  });

  it('filters by attributed context values, provider and model', async () => {
    const { llm, usage } = setup();

    await llm.call(as('acme', 'chat'));
    await llm.call(as('acme', 'search'));
    await llm.call(as('globex', 'chat'));

    expect(usage.totals({ tenantId: 'acme' }).calls).toBe(2);
    expect(usage.totals({ tenantId: 'acme', feature: 'chat' }).calls).toBe(1);
    expect(usage.totals({ tenantId: 'nobody' }).calls).toBe(0);
    expect(usage.totals({}, { model: 'gpt-6-sol' }).calls).toBe(3);
    expect(usage.totals({}, { model: 'cheap' }).calls).toBe(0);
    expect(usage.totals({}, { provider: 'primary' }).calls).toBe(3);
  });

  it('ignores context keys that are not in attribute', async () => {
    const { llm, usage } = setup();

    await llm.call({ ...call, context: { tenantId: 'acme', userId: 'u1' } });

    expect(usage.totals({ userId: 'u1' }).calls).toBe(0);
    expect(usage.totals({ tenantId: 'acme' }).calls).toBe(1);
  });

  it('counts unpriced charges by source and leaves their money out', async () => {
    const { llm, usage } = setup(undefined, {}, 'mystery');

    await llm.call(as('acme'));

    expect(usage.totals()).toMatchObject({
      estimatedCostUsd: 0,
      calls: 1,
      bySource: { reported: 0, table: 0, unpriced: 1 },
      tokens: { input: 60, output: 40 },
    });
  });

  it('counts a call that failed, and what its rejected attempt wasted', async () => {
    const { llm, usage } = setup([new Error('boom')]);

    await expect(llm.call(as('acme'))).rejects.toThrow();

    expect(usage.totals()).toMatchObject({ calls: 1, estimatedCostUsd: 0 });
  });

  it('counts a call a budget rejected as no call at all', async () => {
    const { llm, usage } = setup(undefined, {
      budgets: [{ key: 'tenantId', limitTokens: 120, per: 'day' }],
    });

    await llm.call(as('acme'));
    await expect(llm.call(as('acme'))).rejects.toMatchObject({ code: 'budget_exceeded' });

    expect(usage.totals().calls).toBe(1);
  });

  it('reads the window asked for, and starts again when it rolls over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T23:30:00Z'));
    const { llm, usage } = setup();

    await llm.call(as('acme'));
    expect(usage.totals({}, { window: 'hour' }).calls).toBe(1);
    expect(usage.totals({}, { window: 'month' }).calls).toBe(1);

    vi.setSystemTime(new Date('2026-10-21T00:05:00Z'));
    expect(usage.totals({}, { window: 'day' }).calls).toBe(0);
    expect(usage.totals({}, { window: 'hour' }).calls).toBe(0);
    expect(usage.totals({}, { window: 'month' }).calls).toBe(1);
  });

  it('keeps a bounded number of series, counting the overflow as __other__ with one warning', async () => {
    const { logger, warnings } = captureLogger();
    const { llm, usage } = setup(undefined, { maxSeries: 2, logger });

    for (const tenant of ['a', 'b', 'c', 'd']) await llm.call(as(tenant));

    expect(usage.totals().calls).toBe(4);
    expect(usage.totals({ tenantId: 'c' }).calls).toBe(0);
    expect(warnings().filter((w) => w.includes('maxSeries'))).toHaveLength(1);
  });
});

describe('remaining', () => {
  it('reports each budget that applies, with what is spent, held and left', async () => {
    const { llm, usage } = setup(undefined, {
      budgets: [
        { key: 'tenantId', limitUsd: 0.01, per: 'day' },
        { key: 'feature', limitTokens: 1_000, per: 'hour' },
      ],
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T13:30:00Z'));

    await llm.call(as('acme', 'chat'));

    await expect(usage.remaining({ tenantId: 'acme', feature: 'chat' })).resolves.toEqual([
      {
        key: 'tenantId',
        value: 'acme',
        per: 'day',
        unit: 'usd',
        limit: 0.01,
        mode: 'hard',
        spent: 0.00052,
        reserved: 0,
        remaining: expect.closeTo(0.00948, 12),
        overBy: 0,
        resetsAt: '2026-10-21T00:00:00.000Z',
      },
      {
        key: 'feature',
        value: 'chat',
        per: 'hour',
        unit: 'tokens',
        limit: 1_000,
        mode: 'hard',
        spent: 100,
        reserved: 0,
        remaining: 900,
        overBy: 0,
        resetsAt: '2026-10-20T14:00:00.000Z',
      },
    ]);
  });

  it('leaves out a budget whose key the filter lacks, and answers empty without budgets', async () => {
    const withBudget = setup(undefined, {
      budgets: [{ key: 'tenantId', limitUsd: 1, per: 'day' }],
    });
    const without = setup();

    await expect(withBudget.usage.remaining({ feature: 'chat' })).resolves.toEqual([]);
    await expect(without.usage.remaining({ tenantId: 'acme' })).resolves.toEqual([]);
  });
});
