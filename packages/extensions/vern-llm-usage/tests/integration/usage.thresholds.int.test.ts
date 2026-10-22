import { VernLLM } from 'vern-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { memoryUsageStore, usageMiddleware, type UsageStore } from '../../src/index.js';
import { createMockClient, daysAgo, eventProbe, textResponse } from '../helpers.js';

const prices = { 'gpt-6-sol': { input: 2, output: 10 } };
const call = {
  userContent: 'hi',
  jsonMode: false as const,
  context: { tenantId: 'acme' },
};

/** Each call spends the next entry, in percent of the 10,000 token limit. */
function setup(warnAt: number | number[] | undefined, spends: number[], store?: UsageStore) {
  const probe = eventProbe();
  const script = spends.map((total) =>
    textResponse('ok', {
      prompt_tokens: total * 100,
      completion_tokens: 0,
      total_tokens: total * 100,
    }),
  );
  const llm = new VernLLM({
    client: createMockClient(script).client,
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
        budgets: [{ key: 'tenantId', limitTokens: 10_000, per: 'day' }],
        warnAt,
        store,
        logger: 'silent',
      }),
    ],
  });
  const thresholds = () => probe.events.map((e) => (e.data as { threshold: number }).threshold);
  return { llm, events: probe.events, thresholds };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('warnAt thresholds', () => {
  it('stays quiet below the lowest threshold', async () => {
    const { llm, events } = setup([0.7, 0.9], [30, 30]);

    await llm.call(call);
    await llm.call(call);

    expect(events).toEqual([]);
  });

  it('emits one warning per threshold, in order', async () => {
    const { llm, thresholds } = setup([0.7, 0.9], [75, 20]);

    await llm.call(call);
    expect(thresholds()).toEqual([0.7]);

    await llm.call(call);
    expect(thresholds()).toEqual([0.7, 0.9]);
  });

  it('emits only the highest threshold when one call jumps past several', async () => {
    const { llm, thresholds } = setup([0.7, 0.9], [60, 35, 1]);

    await llm.call(call);
    await llm.call(call);

    expect(thresholds()).toEqual([0.9]);
  });

  it('warns once per threshold, then again in the next window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
    const { llm, thresholds } = setup([0.5, 0.9], [50, 1, 40, 50, 40]);

    await llm.call(call);
    await llm.call(call);
    expect(thresholds()).toEqual([0.5]);

    await llm.call(call);
    expect(thresholds()).toEqual([0.5, 0.9]);

    vi.setSystemTime(new Date('2026-10-21T10:00:00Z'));
    await llm.call(call);
    await llm.call(call);
    expect(thresholds()).toEqual([0.5, 0.9, 0.5, 0.9]);
  });

  it('still takes a single number', async () => {
    const { llm, thresholds } = setup(0.5, [60, 10]);

    await llm.call(call);
    await llm.call(call);

    expect(thresholds()).toEqual([0.5]);
  });

  it('stops reading the store once the top threshold has been emitted', async () => {
    const inner = memoryUsageStore();
    const read = vi.spyOn(inner, 'read');
    const { llm, thresholds } = setup([0.5, 0.9], [55, 40, 1, 1], inner);

    await llm.call(call);
    await llm.call(call);
    expect(thresholds()).toEqual([0.5, 0.9]);

    const before = read.mock.calls.length;
    await llm.call(call).catch(() => undefined);
    await llm.call(call).catch(() => undefined);

    expect(read.mock.calls.length).toBe(before);
  });

  it('rejects an invalid list when the middleware is created', () => {
    for (const bad of [[], [0.5, 1], [0]]) {
      expect(() => setup(bad, [1])).toThrow('warnAt must be one or more numbers');
    }
  });
});
