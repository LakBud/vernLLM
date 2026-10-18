import { describe, it, expect, vi } from 'vitest';

import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, jsonResponse } from '../../helpers.js';

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

describe('VernLLM.readRetryBudgetState (unit)', () => {
  it('is undefined without a budget', async () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({ client, model: 'm' });

    await expect(llm.readRetryBudgetState()).resolves.toBeUndefined();
  });

  it('falls back to the local snapshot for the built in budget', async () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({
      client,
      model: 'm',
      retryBudget: { windowMs: 60_000, minCalls: 10, retryRatio: 0.5 },
    });

    await llm.call({ userContent: 'hello' });

    await expect(llm.readRetryBudgetState()).resolves.toEqual({ attempts: 1, retryRatio: 0 });
  });

  it("asks an adapter's readState for the live window", async () => {
    const { client } = createMockClient([]);
    const readState = vi.fn(async () => ({ attempts: 40, retryRatio: 0.25 }));
    const llm = new VernLLM({
      client,
      model: 'm',
      retryBudget: {
        assertAvailable: () => {},
        recordAttempt: () => {},
        getSnapshot: () => ({ attempts: 1, retryRatio: 0 }),
        readState,
      },
    });

    await expect(llm.readRetryBudgetState()).resolves.toEqual({ attempts: 40, retryRatio: 0.25 });
    expect(llm.getRetryBudgetState()).toEqual({ attempts: 1, retryRatio: 0 });
    expect(readState).toHaveBeenCalledOnce();
  });

  it('is undefined for an adapter with neither readState nor getSnapshot', async () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({
      client,
      model: 'm',
      retryBudget: { assertAvailable: () => {}, recordAttempt: () => {} },
    });

    await expect(llm.readRetryBudgetState()).resolves.toBeUndefined();
    expect(llm.getRetryBudgetState()).toBeUndefined();
  });

  it('reads a fallback target by index', async () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);
    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        retryBudget: {
          assertAvailable: () => {},
          recordAttempt: () => {},
          readState: async () => ({ attempts: 7, retryRatio: 0.5 }),
        },
      },
    });

    await expect(llm.readRetryBudgetState({ index: 0 })).resolves.toBeUndefined();
    await expect(llm.readRetryBudgetState({ index: 1 })).resolves.toEqual({
      attempts: 7,
      retryRatio: 0.5,
    });
  });

  it('rejects with RangeError for an out-of-range index', async () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({ client, model: 'm' });

    await expect(llm.readRetryBudgetState({ index: 9 })).rejects.toThrow(RangeError);
  });
});
