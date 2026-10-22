import { VernLLM } from 'vern-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usageMiddleware, type UsageBudget } from '../../src/index.js';
import { createMockClient, daysAgo, eventProbe, textResponse } from '../helpers.js';

const prices = { 'gpt-6-sol': { input: 2, output: 10 } };
const spent = { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 };
const call = { userContent: 'hi', jsonMode: false as const, context: { tenantId: 'acme' } };

function setup(budgets: UsageBudget[], warnAt?: number) {
  const probe = eventProbe();
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
        attribute: ['tenantId'],
        budgets,
        warnAt,
        logger: 'silent',
      }),
    ],
  });
  return { llm, events: probe.events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('events', () => {
  it('emits usage.budget_exceeded with the budget that was hit, before throwing', async () => {
    const { llm, events } = setup([{ key: 'tenantId', limitTokens: 120, per: 'day' }]);

    await llm.call(call);
    await expect(llm.call(call)).rejects.toMatchObject({ code: 'budget_exceeded' });

    expect(events).toEqual([
      {
        name: 'usage.budget_exceeded',
        data: {
          v: 1,
          scope: 'tenantId=acme per day',
          unit: 'tokens',
          limit: 120,
          remaining: 20,
          mode: 'hard',
          blocked: true,
        },
      },
    ]);
  });

  it('reports a dollar budget in dollars', async () => {
    const { llm, events } = setup([{ key: 'tenantId', limitUsd: 0.001, per: 'day' }]);

    await llm.call(call);
    await expect(llm.call(call)).rejects.toMatchObject({ code: 'budget_exceeded' });

    expect(events[0]!.data).toMatchObject({ unit: 'usd', limit: 0.001 });
    expect((events[0]!.data as { remaining: number }).remaining).toBeCloseTo(0.00048, 12);
  });

  it('warns once when spend reaches warnAt, and not again for the same window', async () => {
    const { llm, events } = setup([{ key: 'tenantId', limitTokens: 200, per: 'day' }], 0.5);

    await llm.call(call);
    await llm.call(call);

    expect(events).toEqual([
      {
        name: 'usage.budget_warning',
        data: {
          v: 1,
          scope: 'tenantId=acme per day',
          unit: 'tokens',
          limit: 200,
          threshold: 0.5,
          mode: 'hard',
          used: 0.5,
        },
      },
    ]);
  });

  it('warns again in the next window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
    const { llm, events } = setup([{ key: 'tenantId', limitTokens: 200, per: 'day' }], 0.5);

    await llm.call(call);
    vi.setSystemTime(new Date('2026-10-21T10:00:00Z'));
    await llm.call(call);

    expect(events.map((e) => e.name)).toEqual(['usage.budget_warning', 'usage.budget_warning']);
  });

  it('does not warn below warnAt, or without warnAt', async () => {
    const below = setup([{ key: 'tenantId', limitTokens: 1_000, per: 'day' }], 0.5);
    const off = setup([{ key: 'tenantId', limitTokens: 100_000, per: 'day' }]);

    await below.llm.call(call);
    await off.llm.call(call);

    expect(below.events).toEqual([]);
    expect(off.events).toEqual([]);
  });
});
