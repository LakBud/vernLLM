import { describe, it, expect } from 'vitest';

import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse } from '../helpers.js';

describe('VernLLM.getRetryBudgetState (unit)', () => {
  it('is undefined by default (opt-in), same as getFailureBreakdown', () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    expect(llm.getRetryBudgetState()).toBeUndefined();
  });

  it('reports an empty snapshot once configured but before any call', () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({
      client,
      model: 'm',
      retryBudget: { windowMs: 60_000, minCalls: 10, retryRatio: 0.5 },
    });

    expect(llm.getRetryBudgetState()).toEqual({ attempts: 0, retryRatio: 0 });
  });

  it('reflects real call attempts on the primary target', async () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({
      client,
      model: 'm',
      retryBudget: { windowMs: 60_000, minCalls: 10, retryRatio: 0.5 },
    });

    await llm.call({ userContent: 'hello' });

    expect(llm.getRetryBudgetState()).toEqual({ attempts: 1, retryRatio: 0 });
  });

  it('reads a fallback target by index, independent of the primary and not inherited from it', async () => {
    const { client: primaryClient } = createMockClient([jsonResponse({ ok: true })]);
    const { client: fallbackClient } = createMockClient([jsonResponse({ ok: true })]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      retryBudget: { windowMs: 60_000, minCalls: 10, retryRatio: 0.5 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        // No retryBudget here on purpose: proves the primary's isn't inherited.
      },
    });

    await llm.call({ userContent: 'hello' });

    expect(llm.getRetryBudgetState({ index: 0 })).toEqual({ attempts: 1, retryRatio: 0 });
    expect(llm.getRetryBudgetState({ index: 1 })).toBeUndefined();
  });

  it('throws RangeError for an out-of-range index', () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({
      client,
      model: 'm',
      retryBudget: { windowMs: 60_000, minCalls: 10, retryRatio: 0.5 },
    });

    expect(() => llm.getRetryBudgetState({ index: 9 })).toThrow(RangeError);
  });
});
