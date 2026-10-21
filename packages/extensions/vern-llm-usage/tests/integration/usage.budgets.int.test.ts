import { LLMError, VernLLM } from 'vern-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usageMiddleware, type UsageBudget } from '../../src/index.js';
import { createMockClient, daysAgo, textResponse } from '../helpers.js';

const prices = { 'gpt-6-sol': { input: 2, output: 10 }, cheap: { input: 1, output: 1 } };
// 100 tokens spent, and 520,000 nano dollars at the gpt-6-sol rates.
const spent = { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 };
const call = { userContent: 'hi', jsonMode: false as const };

function setup(
  budgets: UsageBudget[],
  script = [textResponse('ok', spent)],
  extra: Partial<ConstructorParameters<typeof VernLLM>[0]> = {},
  model = 'gpt-6-sol',
  timeZone?: string,
) {
  const { client, calls } = createMockClient(script);
  const usage = usageMiddleware({
    prices,
    pricesAsOf: daysAgo(1),
    attribute: ['tenantId', 'team'],
    budgets,
    logger: 'silent',
    ...(timeZone ? { timeZone } : {}),
  });
  const llm = new VernLLM({
    client,
    model,
    maxRetries: 0,
    baseDelayMs: 1,
    logger: 'silent',
    defaultMaxTokens: 50,
    middleware: [usage],
    ...extra,
  });
  return { llm, calls, usage };
}

const as = (tenantId: string) => ({ ...call, context: { tenantId } });

afterEach(() => {
  vi.useRealTimers();
});

describe('budgets', () => {
  it('rejects before any provider is contacted, as quota_exceeded with budget_exceeded', async () => {
    const { llm, calls } = setup([{ key: 'tenantId', limitTokens: 120, per: 'day' }]);

    await llm.call(as('acme'));
    const error = await llm.call(as('acme')).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({
      type: 'quota_exceeded',
      code: 'budget_exceeded',
      message: 'Budget exceeded: tenantId=acme per day',
    });
    expect(calls).toHaveLength(1);
  });

  it('leaves the circuit breaker and the fallback alone', async () => {
    const backup = createMockClient([textResponse('from backup', spent)]);
    const { llm, calls } = setup(
      [{ key: 'tenantId', limitTokens: 120, per: 'day' }],
      [textResponse('ok', spent)],
      {
        circuitBreaker: { threshold: 2, cooldownMs: 10_000 },
        fallback: { client: backup.client, model: 'cheap', name: 'backup' },
      },
    );

    await llm.call(as('acme'));
    for (let i = 0; i < 4; i++) {
      await expect(llm.call(as('acme'))).rejects.toMatchObject({ code: 'budget_exceeded' });
    }

    expect(calls).toHaveLength(1);
    expect(backup.calls).toHaveLength(0);
    // Four rejections against a threshold of two: none of them counted as a failure.
    expect(llm.getCircuitStates()[0]).toMatchObject({ state: 'closed' });
  });

  it('gives each value of a key its own budget', async () => {
    const { llm } = setup([{ key: 'tenantId', limitTokens: 120, per: 'day' }]);

    await llm.call(as('a'));
    await expect(llm.call(as('a'))).rejects.toMatchObject({ code: 'budget_exceeded' });

    await expect(llm.call(as('b'))).resolves.toBe('ok');
  });

  it('limits only the value named by equals', async () => {
    const { llm } = setup([{ key: 'tenantId', equals: 'free', limitTokens: 120, per: 'day' }]);

    await llm.call(as('free'));
    await expect(llm.call(as('free'))).rejects.toMatchObject({ code: 'budget_exceeded' });

    await llm.call(as('paid'));
    await expect(llm.call(as('paid'))).resolves.toBe('ok');
  });

  it('does not limit a call that lacks the key, or carries no context', async () => {
    const { llm } = setup([{ key: 'tenantId', limitTokens: 120, per: 'day' }]);

    for (let i = 0; i < 3; i++) {
      await expect(llm.call(call)).resolves.toBe('ok');
      await expect(llm.call({ ...call, context: { team: 'x' } })).resolves.toBe('ok');
    }
  });

  it('enforces a dollar budget from the priced spend', async () => {
    const { llm, calls } = setup([{ key: 'tenantId', limitUsd: 0.001, per: 'day' }]);

    await llm.call(as('acme'));
    await expect(llm.call(as('acme'))).rejects.toMatchObject({
      type: 'quota_exceeded',
      code: 'budget_exceeded',
    });
    expect(calls).toHaveLength(1);
  });

  it('ignores unpriced calls in a dollar budget but counts them in a token budget', async () => {
    const usd = setup(
      [{ key: 'tenantId', limitUsd: 0.000001, per: 'day' }],
      undefined,
      {},
      'mystery',
    );
    for (let i = 0; i < 3; i++) await expect(usd.llm.call(as('a'))).resolves.toBe('ok');

    const tokens = setup(
      [{ key: 'tenantId', limitTokens: 120, per: 'day' }],
      undefined,
      {},
      'mystery',
    );
    await tokens.llm.call(as('a'));
    await expect(tokens.llm.call(as('a'))).rejects.toMatchObject({ code: 'budget_exceeded' });
  });

  it('starts again from zero when the window rolls over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T23:59:00Z'));
    const { llm } = setup([{ key: 'tenantId', limitTokens: 120, per: 'day' }]);

    await llm.call(as('acme'));
    await expect(llm.call(as('acme'))).rejects.toMatchObject({ code: 'budget_exceeded' });

    vi.setSystemTime(new Date('2026-10-21T00:00:01Z'));
    await expect(llm.call(as('acme'))).resolves.toBe('ok');
  });

  it('rolls the day over at midnight in the configured time zone', async () => {
    // 03:30 UTC is 23:30 on 20 Oct in New York, so midnight there is at 04:00 UTC.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T03:30:00Z'));
    const { llm, usage } = setup(
      [{ key: 'tenantId', limitTokens: 120, per: 'day' }],
      undefined,
      {},
      'gpt-6-sol',
      'America/New_York',
    );

    await llm.call(as('acme'));
    await expect(llm.call(as('acme'))).rejects.toMatchObject({ code: 'budget_exceeded' });
    const [status] = await usage.remaining({ tenantId: 'acme' });
    expect(status!.resetsAt).toBe('2026-10-21T04:00:00.000Z');

    // Past UTC midnight the day is the same there, so it is still full.
    vi.setSystemTime(new Date('2026-10-21T03:59:59Z'));
    await expect(llm.call(as('acme'))).rejects.toMatchObject({ code: 'budget_exceeded' });

    vi.setSystemTime(new Date('2026-10-21T04:00:01Z'));
    await expect(llm.call(as('acme'))).resolves.toBe('ok');
  });

  it('applies several budgets to one call and names the one that was hit', async () => {
    const { llm } = setup([
      { key: 'tenantId', limitTokens: 10_000, per: 'day' },
      { key: 'team', limitTokens: 120, per: 'hour' },
    ]);
    const params = { ...call, context: { tenantId: 'a', team: 'search' } };

    await llm.call(params);
    await expect(llm.call(params)).rejects.toThrow('Budget exceeded: team=search per hour');
  });
});
