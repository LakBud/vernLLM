import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { memoryUsageStore, usageMiddleware, type UsageStore } from '../../src/index.js';
import { createMockClient, daysAgo, eventProbe, spyStore, textResponse } from '../helpers.js';

const prices = { 'gpt-6-sol': { input: 2, output: 10 } };
const spent = { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 };
const call = { userContent: 'hi', jsonMode: false as const, context: { tenantId: 'acme' } };

function setup(store: UsageStore, budgets = [{ key: 'tenantId', limitTokens: 250, per: 'day' }]) {
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
        budgets: budgets as never,
        warnAt: 0.5,
        store,
        logger: 'silent',
      }),
    ],
  });
  return { llm, events: probe.events };
}

describe('compatibility', () => {
  it('keeps the stored key and real limit of a hard budget as before', async () => {
    const spy = spyStore();
    const { llm } = setup(spy.store);

    await llm.call(call);

    const [scope] = spy.reserved()[0]!.scopes;
    expect(scope!.key).toMatch(/^\["tenantId",null,"tokens","acme","day:\d{4}-\d{2}-\d{2}"\]$/);
    expect(scope!.limit).toBe(250);
  });

  it('works with a custom store that only has the original four methods and replies', async () => {
    const inner = memoryUsageStore();
    const store: UsageStore = {
      reserve: (scopes, amount, ttlMs) => inner.reserve(scopes, amount, ttlMs),
      commit: (id, actual) => inner.commit(id, actual),
      release: (id) => inner.release(id),
      read: (scope) => inner.read(scope),
    };
    const { llm, events } = setup(store);

    await llm.call(call);
    await llm.call(call);
    await expect(llm.call(call)).rejects.toMatchObject({ code: 'budget_exceeded' });

    expect(events.map((e) => e.name)).toEqual(['usage.budget_warning', 'usage.budget_exceeded']);
  });
});
