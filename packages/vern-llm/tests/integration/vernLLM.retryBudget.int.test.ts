import { describe, expect, it } from 'vitest';

import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, FakeApiError, jsonResponse } from '../helpers.js';

/**
 * A retry budget caps how much of a target's recent traffic is allowed
 * to be retries, independent of the circuit breaker. These tests exercise
 * it end to end through `VernLLM.call`, per the design doc's ordering
 * claim (section 10.2): the breaker's gate runs once, up front, per
 * logical call; the budget's gate runs fresh at each retry, so a call can
 * clear the breaker and still get cut off by the budget partway through
 * its own retries.
 */
describe('retry budget end to end', () => {
  it('cuts a call off with retry_budget_exhausted once retries exceed the configured ratio, breaker never trips', async () => {
    const { client } = createMockClient([new FakeApiError('down', 500)]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 5,
      baseDelayMs: 1,
      // High enough threshold that the breaker itself never trips here,
      // isolating the budget as the thing that actually stops the call.
      circuitBreaker: { threshold: 100, cooldownMs: 10_000 },
      retryBudget: { windowMs: 60_000, minCalls: 4, retryRatio: 0.5 },
    });

    await expect(llm.call({ userContent: 'hello' })).rejects.toMatchObject({
      code: 'retry_budget_exhausted',
      type: 'rate_limited',
    });

    // The breaker's own gate never fired: it stayed closed the whole
    // time, proving the budget is a distinct, independent gate rather
    // than a relabeling of the breaker's own trip.
    expect(llm.getCircuitStates()[0]?.state).toBe('closed');
  });

  it('a breaker can still trip on its own while a configured budget never does', async () => {
    const { client } = createMockClient([
      new FakeApiError('down', 500),
      new FakeApiError('down', 500),
    ]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      circuitBreaker: { threshold: 2, cooldownMs: 10_000 },
      // Ratio/minCalls set high enough that this budget never trips
      // across these two calls.
      retryBudget: { windowMs: 60_000, minCalls: 100, retryRatio: 0.9 },
    });

    await expect(llm.call({ userContent: 'hello' })).rejects.toMatchObject({ type: 'api' });
    expect(llm.getCircuitStates()[0]?.state).toBe('closed');

    await expect(llm.call({ userContent: 'hello' })).rejects.toMatchObject({ type: 'api' });
    expect(llm.getCircuitStates()[0]?.state).toBe('open');

    expect(llm.getRetryBudgetState()?.attempts).toBe(2);
  });

  it('a budget rejection is distinguishable from a breaker rejection by code', async () => {
    const { client } = createMockClient([new FakeApiError('down', 500)]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      // No retries at all: `assertAvailable` only ever gates a *retry*
      // (see `shouldRetryAttempt`), never a call's first attempt, so
      // with `maxRetries: 0` the budget can't be what stops this call
      // no matter how it's configured. Isolates the breaker's own
      // `circuit_open` as the only thing that can fire here.
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      retryBudget: { windowMs: 60_000, minCalls: 1, retryRatio: 0 },
    });

    // First call fails outright and trips the breaker (threshold 1).
    await expect(llm.call({ userContent: 'hello' })).rejects.toMatchObject({ type: 'api' });

    // Second call never reaches the provider at all: the breaker's own
    // gate rejects it up front with `circuit_open`/`circuit_cooling_down`,
    // not `retry_budget_exhausted`, even though the budget is configured
    // to trip on the very first retry-eligible call.
    await expect(llm.call({ userContent: 'hello' })).rejects.toMatchObject({
      type: 'circuit_open',
      code: 'circuit_cooling_down',
    });
  });

  it('one target-wide budget is shared across every model routed through it, not isolated per model', async () => {
    const { client } = createMockClient([new FakeApiError('down', 500)]);

    const llm = new VernLLM({
      client,
      model: 'default-model',
      maxRetries: 0,
      retryBudget: { windowMs: 60_000, minCalls: 10, retryRatio: 0.9 },
    });

    await llm.call({ userContent: 'hello', model: 'model-a' }).catch(() => {});
    await llm.call({ userContent: 'hello', model: 'model-a' }).catch(() => {});
    await llm.call({ userContent: 'hello', model: 'model-b' }).catch(() => {});

    // Every attempt, regardless of which model it targeted, lands in the
    // same budget: three calls against one target report three attempts.
    expect(llm.getRetryBudgetState()).toEqual({ attempts: 3, retryRatio: 0 });
  });

  it('a successful call still works normally alongside a configured budget', async () => {
    const { client } = createMockClient([jsonResponse({ answer: 'ok' })]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      retryBudget: { windowMs: 60_000, minCalls: 5, retryRatio: 0.5 },
    });

    const result = await llm.call({ userContent: 'hello' });
    expect(result).toBeDefined();
    expect(llm.getRetryBudgetState()).toEqual({ attempts: 1, retryRatio: 0 });
  });
});
