import { VernLLM, type VernLLMMiddleware } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import {
  usageBudgetShare,
  usageMiddleware,
  type BudgetShareOptions,
  type UsageBudget,
  type UsageStore,
} from '../../src/index.js';
import { costProbe, createMockClient, daysAgo, spyStore, textResponse } from '../helpers.js';

const prices = { 'gpt-6-sol': { input: 2, output: 10 } };
// 100 tokens per call.
const spent = { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 };
const tenant = { tenantId: 'acme', plan: 'pro' };

function setup(
  budgets: UsageBudget[],
  options: { store?: UsageStore; onStoreError?: 'allow' | 'deny' } = {},
) {
  const spy = spyStore();
  const seen: (number | undefined)[] = [];
  const filters: BudgetShareOptions[] = [{}];
  const probe = costProbe();

  // A plain middleware inside usage: it needs nothing but the exported helper.
  const reader: VernLLMMiddleware = {
    name: 'reader',
    position: 0,
    wrap: async (_request, next, ctx) => {
      for (const filter of filters) seen.push(usageBudgetShare(ctx, filter));
      return next();
    },
  };
  const llm = new VernLLM({
    client: createMockClient([textResponse('ok', spent)]).client,
    model: 'gpt-6-sol',
    maxRetries: 0,
    logger: 'silent',
    defaultMaxTokens: 50,
    middleware: [
      probe.middleware,
      usageMiddleware({
        prices,
        pricesAsOf: daysAgo(1),
        attribute: ['tenantId', 'plan'],
        budgets,
        store: options.store ?? spy.store,
        onStoreError: options.onStoreError,
        logger: 'silent',
      }),
      reader,
    ],
  });
  const call = (context: Record<string, string> = tenant) =>
    llm.call({ userContent: 'hi', jsonMode: false as const, context });
  return { call, seen, filters, finished: probe.fields, spy };
}

const hold = (spy: ReturnType<typeof spyStore>) => spy.reserved()[0]!.amount.tokens;

describe('usageBudgetShare', () => {
  it('is visible before next(), counts this call hold, then spend', async () => {
    const { call, seen, spy } = setup([{ key: 'tenantId', limitTokens: 1000, per: 'day' }]);

    await call();
    await call();

    expect(seen[0]).toBeCloseTo(hold(spy) / 1000);
    // 100 tokens spent by the first call, plus the second call's own hold.
    expect(seen[1]).toBeCloseTo((100 + hold(spy)) / 1000);
  });

  it('takes the highest share, and filters by key and mode', async () => {
    const { call, seen, filters } = setup([
      { key: 'tenantId', limitTokens: 10_000, per: 'day' },
      { key: 'plan', limitTokens: 500, per: 'day', mode: 'soft' },
    ]);
    filters.push(
      { key: 'tenantId' },
      { key: 'plan' },
      { mode: 'hard' },
      { mode: 'soft' },
      { key: 'other' },
    );

    await call();

    const [highest, tenantShare, planShare, hard, soft, other] = seen;
    expect(planShare).toBeGreaterThan(tenantShare!);
    expect(highest).toBe(planShare);
    expect(hard).toBe(tenantShare);
    expect(soft).toBe(planShare);
    expect(other).toBeUndefined();
  });

  it('keeps the highest share when a later budget is lower', async () => {
    const { call, seen, spy } = setup([
      { key: 'plan', limitTokens: 500, per: 'day' },
      { key: 'tenantId', limitTokens: 10_000, per: 'day' },
    ]);

    await call();

    expect(seen[0]).toBeCloseTo(hold(spy) / 500);
  });

  it('can pass 1 on a soft budget, which never refuses', async () => {
    const { call, seen, filters } = setup([
      { key: 'tenantId', limitTokens: 150, per: 'day', mode: 'soft' },
    ]);
    filters.length = 0;
    filters.push({ mode: 'soft' });

    await call();
    await call();
    await call();

    expect(seen.at(-1)).toBeGreaterThan(1);
  });

  it('is undefined for a call under no budget', async () => {
    const { call, seen } = setup([{ key: 'tenantId', limitTokens: 1000, per: 'day' }]);

    await call({ plan: 'pro' });

    expect(seen).toEqual([undefined]);
  });

  it('is undefined when the store reports no figures', async () => {
    const spy = spyStore();
    const bare: UsageStore = {
      ...spy.store,
      reserve: async (scopes, amount, ttlMs) => {
        const outcome = await spy.store.reserve(scopes, amount, ttlMs);
        return outcome.ok ? { ok: true, id: outcome.id } : outcome;
      },
    };
    const { call, seen, finished } = setup([{ key: 'tenantId', limitTokens: 1000, per: 'day' }], {
      store: bare,
    });

    await call();

    expect(seen).toEqual([undefined]);
    expect(finished[0]).not.toHaveProperty('budgetShare');
  });

  it('is undefined after a store error under onStoreError allow', async () => {
    const spy = spyStore();
    const failing: UsageStore = {
      ...spy.store,
      reserve: async () => {
        throw new Error('down');
      },
    };
    const { call, seen } = setup([{ key: 'tenantId', limitTokens: 1000, per: 'day' }], {
      store: failing,
      onStoreError: 'allow',
    });

    await call();

    expect(seen).toEqual([undefined]);
  });

  it('puts the highest share in the log fields as budgetShare', async () => {
    const { call, seen, finished } = setup([{ key: 'tenantId', limitTokens: 1000, per: 'day' }]);

    await call();

    expect(finished[0]?.budgetShare).toBe(seen[0]);
  });
});
