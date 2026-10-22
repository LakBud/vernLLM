import { VernLLM } from 'vern-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usageMiddleware, type UsageBudget } from '../../src/index.js';
import { createMockClient, daysAgo, eventProbe, spyStore, textResponse } from '../helpers.js';

const prices = { 'gpt-6-sol': { input: 2, output: 10 } };
// 100 tokens per call.
const spent = { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 };
const call = { userContent: 'hi', jsonMode: false as const, context: { tenantId: 'acme' } };

function setup(budgets: UsageBudget[], extra: { warnAt?: number } = {}) {
  const probe = eventProbe();
  const spy = spyStore();
  const usage = usageMiddleware({
    prices,
    pricesAsOf: daysAgo(1),
    attribute: ['tenantId'],
    budgets,
    store: spy.store,
    logger: 'silent',
    ...extra,
  });
  const llm = new VernLLM({
    client: createMockClient([textResponse('ok', spent)]).client,
    model: 'gpt-6-sol',
    maxRetries: 0,
    logger: 'silent',
    defaultMaxTokens: 50,
    middleware: [probe.middleware, usage],
  });
  return { llm, usage, spy, events: probe.events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('soft budgets', () => {
  it('never refuse a call, and still record the spend', async () => {
    const { llm, usage } = setup([{ key: 'tenantId', limitTokens: 150, per: 'day', mode: 'soft' }]);

    for (let i = 0; i < 4; i++) await llm.call(call);

    const { tokens } = usage.totals({ tenantId: 'acme' });
    expect(tokens.input + tokens.output).toBe(400);
  });

  it('emit usage.budget_exceeded once per window, with blocked false', async () => {
    const { llm, events } = setup([
      { key: 'tenantId', limitTokens: 150, per: 'day', mode: 'soft' },
    ]);

    await llm.call(call);
    expect(events).toEqual([]);

    await llm.call(call);
    await llm.call(call);
    await llm.call(call);

    expect(events).toEqual([
      {
        name: 'usage.budget_exceeded',
        data: {
          v: 1,
          scope: 'tenantId=acme per day',
          unit: 'tokens',
          limit: 150,
          remaining: 0,
          mode: 'soft',
          blocked: false,
        },
      },
    ]);
  });

  it('alert again in the next window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
    const { llm, events } = setup([{ key: 'tenantId', limitTokens: 50, per: 'day', mode: 'soft' }]);

    await llm.call(call);
    await llm.call(call);
    vi.setSystemTime(new Date('2026-10-21T10:00:00Z'));
    await llm.call(call);

    expect(events.map((e) => e.name)).toEqual(['usage.budget_exceeded', 'usage.budget_exceeded']);
  });

  it('give warnAt thresholds too, before the soft alert', async () => {
    const { llm, events } = setup(
      [{ key: 'tenantId', limitTokens: 200, per: 'day', mode: 'soft' }],
      { warnAt: 0.4 },
    );

    await llm.call(call);
    await llm.call(call);

    expect(events.map((e) => [e.name, (e.data as { mode: string }).mode])).toEqual([
      ['usage.budget_warning', 'soft'],
      ['usage.budget_exceeded', 'soft'],
    ]);
  });

  it('pair with a hard budget on one key, each with its own counter', async () => {
    const { llm, usage, events } = setup([
      { key: 'tenantId', limitTokens: 150, per: 'day', mode: 'soft' },
      { key: 'tenantId', limitTokens: 200, per: 'day' },
    ]);

    await llm.call(call);
    await llm.call(call);
    await expect(llm.call(call)).rejects.toMatchObject({ code: 'budget_exceeded' });

    expect(events.map((e) => e.data)).toMatchObject([
      { mode: 'soft', blocked: false },
      { mode: 'hard', blocked: true },
    ]);
    // Shared counters would show 400 here.
    const [soft, hard] = await usage.remaining({ tenantId: 'acme' });
    expect([soft!.spent, hard!.spent]).toEqual([200, 200]);
  });

  it('show in remaining() with mode and overBy, and remaining clamped at 0', async () => {
    const { llm, usage } = setup([
      { key: 'tenantId', limitTokens: 150, per: 'day', mode: 'soft' },
      { key: 'tenantId', limitTokens: 1_000, per: 'day' },
    ]);

    await llm.call(call);
    await llm.call(call);

    const [soft, hard] = await usage.remaining({ tenantId: 'acme' });
    expect(soft).toMatchObject({ mode: 'soft', limit: 150, remaining: 0, overBy: 50 });
    expect(hard).toMatchObject({ mode: 'hard', remaining: 800, overBy: 0 });
  });

  it('give the store an unreachable limit, and keep the real one for the alert', async () => {
    const { llm, spy } = setup([{ key: 'tenantId', limitTokens: 150, per: 'day', mode: 'soft' }]);

    await llm.call(call);

    expect(spy.reserved()[0]!.scopes[0]!.limit).toBe(Number.MAX_SAFE_INTEGER);
  });
});
