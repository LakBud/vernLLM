import { defaultEstimateTokens, VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { usageMiddleware, type CostFor } from '../../src/index.js';
import { createMockClient, daysAgo, spyStore, textResponse } from '../helpers.js';

const prices = {
  cheap: { input: 1, output: 1 },
  'gpt-6-sol': { input: 2, output: 10 },
  thinker: { input: 1, output: 4, reasoning: 20 },
};
const call = { userContent: 'hello there', jsonMode: false as const, context: { tenantId: 'a' } };

function setup(model: string, extra: Partial<ConstructorParameters<typeof VernLLM>[0]> = {}) {
  const spy = spyStore();
  const { client, calls } = createMockClient([textResponse('ok')]);
  const llm = new VernLLM({
    client,
    model,
    maxRetries: 0,
    logger: 'silent',
    defaultMaxTokens: 50,
    middleware: [
      usageMiddleware({
        prices,
        pricesAsOf: daysAgo(1),
        attribute: ['tenantId'],
        budgets: [{ key: 'tenantId', limitTokens: 1_000_000, per: 'day' }],
        store: spy.store,
        logger: 'silent',
      }),
    ],
    ...extra,
  });
  return { llm, spy, calls };
}

describe('reservation estimate', () => {
  it('holds exactly what the core estimates for the request, max_tokens counted once', async () => {
    const { llm, spy, calls } = setup('gpt-6-sol');

    await llm.call(call);

    const { amount } = spy.reserved()[0]!;
    expect(amount.tokens).toBe(defaultEstimateTokens(calls[0] as never));
    // Input is what is left after max_tokens, so the dollars add up to input plus output once.
    const input = amount.tokens - 50;
    expect(input).toBeGreaterThan(0);
    expect(amount.nanoUsd).toBe(input * 2_000 + 50 * 10_000);
  });

  it('prices the dearest allowed target, so a fallback cannot overshoot the budget', async () => {
    const backup = createMockClient([textResponse('ok')]);
    const { llm, spy } = setup('cheap', {
      fallback: { client: backup.client, model: 'gpt-6-sol', name: 'backup' },
    });

    await llm.call(call);

    const { amount } = spy.reserved()[0]!;
    const input = amount.tokens - 50;
    expect(amount.nanoUsd).toBe(input * 2_000 + 50 * 10_000);
  });

  it('prices output as reasoning when reasoning is the dearer rate', async () => {
    const { llm, spy } = setup('thinker');

    await llm.call(call);

    const { amount } = spy.reserved()[0]!;
    const input = amount.tokens - 50;
    expect(amount.nanoUsd).toBe(input * 1_000 + 50 * 20_000);
  });

  it('skips targets without a price, holding tokens only when none has one', async () => {
    const { llm, spy } = setup('mystery');

    await llm.call(call);

    const { amount } = spy.reserved()[0]!;
    expect(amount.nanoUsd).toBe(0);
    expect(amount.tokens).toBeGreaterThan(50);
  });

  it('prices a priced target even when another one is unpriced', async () => {
    const backup = createMockClient([textResponse('ok')]);
    const { llm, spy } = setup('mystery', {
      fallback: { client: backup.client, model: 'cheap', name: 'backup' },
    });

    await llm.call(call);

    const { amount } = spy.reserved()[0]!;
    expect(amount.nanoUsd).toBe((amount.tokens - 50) * 1_000 + 50 * 1_000);
  });
});

describe('costFor', () => {
  const request = { messages: [{ role: 'user', content: 'hello there' }], max_tokens: 50 } as never;
  const usage = usageMiddleware({ prices, pricesAsOf: daysAgo(1), logger: 'silent' });

  it('prices the same worst case a budget would hold, in dollars', async () => {
    const spy = spyStore();
    const { client, calls } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({
      client,
      model: 'gpt-6-sol',
      maxRetries: 0,
      logger: 'silent',
      defaultMaxTokens: 50,
      middleware: [
        usageMiddleware({
          prices,
          pricesAsOf: daysAgo(1),
          attribute: ['tenantId'],
          budgets: [{ key: 'tenantId', limitTokens: 1_000_000, per: 'day' }],
          store: spy.store,
          logger: 'silent',
        }),
      ],
    });
    await llm.call(call);

    const held = spy.reserved()[0]!.amount.nanoUsd / 1e9;
    expect(usage.costFor({ name: 'primary', model: 'gpt-6-sol' }, calls[0] as never)).toBeCloseTo(
      held,
      12,
    );
  });

  it('is dearer for a dearer model, and undefined for a model with no price', () => {
    const cheap = usage.costFor({ name: 'primary', model: 'cheap' }, request)!;
    const sol = usage.costFor({ name: 'primary', model: 'gpt-6-sol' }, request)!;

    expect(sol).toBeGreaterThan(cheap);
    expect(usage.costFor({ name: 'primary', model: 'mystery' }, request)).toBeUndefined();
  });

  it('is a CostFor that works detached, so a router needs no import of this package', () => {
    // A router that only knows the shape: weigh targets by cost, skip those it cannot price.
    const cheapestOf = (
      names: Array<{ name: string; model: string }>,
      costFor: CostFor,
    ): string | undefined =>
      names
        .map((target) => ({ target, cost: costFor(target, request) }))
        .filter(
          (entry): entry is { target: (typeof names)[number]; cost: number } =>
            entry.cost !== undefined,
        )
        .sort((a, b) => a.cost - b.cost)[0]?.target.name;

    const { costFor } = usage;
    const targets = [
      { name: 'big', model: 'gpt-6-sol' },
      { name: 'small', model: 'cheap' },
      { name: 'unknown', model: 'mystery' },
    ];

    expect(cheapestOf(targets, costFor)).toBe('small');
    expect(cheapestOf(targets, () => undefined)).toBeUndefined();
  });

  it('never throws, even for a request it cannot read', () => {
    expect(usage.costFor({ name: 'primary', model: 'cheap' }, undefined as never)).toBeUndefined();
  });
});
