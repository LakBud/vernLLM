import { LLMError, type PreDispatchContext, type WireCallRequest } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { memoryUsageStore, type UsageStore } from '../../../../src/index.js';
import { BudgetGate } from '../../../../src/internal/budgets/gate.js';
import { createGuard } from '../../../../src/internal/guard.utils.js';
import { PriceTable } from '../../../../src/internal/pricing/priceTable.js';
import { captureLogger } from '../../../helpers.js';

const request: WireCallRequest = {
  model: 'm',
  max_tokens: 10,
  messages: [{ role: 'user', content: 'hi' }],
};

function setup(onStoreError: 'allow' | 'deny', store: UsageStore = memoryUsageStore()) {
  const { logger, errors } = captureLogger();
  const gate = new BudgetGate(
    {
      budgets: [
        {
          key: 'tenantId',
          equals: undefined,
          unit: 'tokens',
          limit: 1_000,
          per: 'day' as const,
          mode: 'hard' as const,
        },
      ],
      onStoreError,
      timeZone: 'UTC',
    },
    store,
    new PriceTable({ prices: undefined, priceFor: undefined, normalizeModel: undefined }),
    createGuard(logger),
  );
  return { gate, errors };
}

// Without `targets`, working out the estimate throws: a failure of the gate itself.
const broken = { context: { tenantId: 'acme' }, emit: () => {} } as unknown as PreDispatchContext;

describe('BudgetGate, when it cannot work out the estimate', () => {
  it('lets the call through unmetered and logs it when onStoreError is allow', async () => {
    const { gate, errors } = setup('allow');

    await expect(gate.reserve(request, broken)).resolves.toBeUndefined();

    expect(errors()).toEqual(['[VernLLM] usage: reserve failed']);
  });

  it('rejects the call like an exceeded budget when onStoreError is deny', async () => {
    const { gate } = setup('deny');

    const error = await gate.reserve(request, broken).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({ type: 'quota_exceeded', code: 'budget_exceeded' });
  });
});

describe('BudgetGate', () => {
  it('returns what it held, so a call with unknown spend can keep it', async () => {
    const { gate } = setup('allow');
    const ctx = { context: { tenantId: 'acme' }, targets: [], emit: () => {} };

    const reservation = await gate.reserve(request, ctx as unknown as PreDispatchContext);

    expect(reservation?.held.tokens).toBeGreaterThan(0);
    expect(reservation?.scopes).toHaveLength(1);
  });

  it('ignores a used figure a custom store reports as something other than a number', async () => {
    const healthy = memoryUsageStore();
    const store: UsageStore = {
      ...healthy,
      reserve: async (scopes, amount, ttlMs) => {
        const outcome = await healthy.reserve(scopes, amount, ttlMs);
        // The type forbids this, but a JavaScript store can still return malformed data.
        return outcome.ok ? { ...outcome, used: [undefined as unknown as number] } : outcome;
      },
    };
    const { gate } = setup('allow', store);
    const ctx = { context: { tenantId: 'acme' }, targets: [], emit: () => {} };

    const reservation = await gate.reserve(request, ctx as unknown as PreDispatchContext);

    expect(reservation?.shares).toEqual([]);
  });
});
