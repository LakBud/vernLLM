import { afterEach, describe, expect, it, vi } from 'vitest';

import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, FakeApiError, jsonResponse } from '../../helpers.js';

/**
 * A half-open trial that ends in an error the breaker deliberately ignores
 * (quota, validation, local rate limit, ...) never reaches recordSuccess or
 * recordFailure. Before releaseTrial, that left the circuit half-open with
 * its only trial slot held forever.
 */
describe('half-open trial released when the call records no outcome', () => {
  afterEach(() => vi.useRealTimers());

  async function tripAndCool(llm: VernLLM) {
    await expect(llm.call({ userContent: 'x' })).rejects.toBeDefined();
    expect(llm.getCircuitStates()[0]?.state).toBe('open');
    vi.advanceTimersByTime(1500);
  }

  it('a trial failing with quota_exceeded does not wedge the circuit', async () => {
    vi.useFakeTimers();
    const { client } = createMockClient([new FakeApiError('down', 500), jsonResponse({ a: 1 })]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      baseDelayMs: 1,
      circuitBreaker: { threshold: 1, cooldownMs: 1000 },
    });

    await tripAndCool(llm);

    await expect(
      llm.call({
        userContent: 'x',
        reserveUsage: async () => {
          throw new Error('over quota');
        },
      }),
    ).rejects.toMatchObject({ type: 'quota_exceeded' });

    // The slot came back: this call is a fresh trial, not "no trial available".
    await expect(llm.call({ userContent: 'x' })).resolves.toBeDefined();
    expect(llm.getCircuitStates()[0]?.state).toBe('closed');
  });

  it('a trial ending in a parse error does not wedge the circuit', async () => {
    vi.useFakeTimers();
    const { client } = createMockClient([
      new FakeApiError('down', 500),
      { choices: [{ message: { content: 'not json' } }] } as never,
      jsonResponse({ a: 1 }),
    ]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      baseDelayMs: 1,
      circuitBreaker: { threshold: 1, cooldownMs: 1000 },
    });

    await tripAndCool(llm);
    await expect(llm.call({ userContent: 'x', jsonMode: true })).rejects.toBeDefined();

    const state = llm.getCircuitStates()[0]?.state;
    expect(state).toBe('half-open');
    await expect(llm.call({ userContent: 'x' })).resolves.toBeDefined();
    expect(llm.getCircuitStates()[0]?.state).toBe('closed');
  });

  it('an aborted trial does not wedge the circuit', async () => {
    vi.useFakeTimers();
    const { client } = createMockClient([new FakeApiError('down', 500), jsonResponse({ a: 1 })]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      baseDelayMs: 1,
      circuitBreaker: { threshold: 1, cooldownMs: 1000 },
    });

    await tripAndCool(llm);

    const controller = new AbortController();
    const pending = llm.call({
      userContent: 'x',
      signal: controller.signal,
      reserveUsage: async () => {
        controller.abort();
        await Promise.resolve();
      },
    });
    await expect(pending).rejects.toBeDefined();

    await expect(llm.call({ userContent: 'x' })).resolves.toBeDefined();
    expect(llm.getCircuitStates()[0]?.state).toBe('closed');
  });

  it('a real failure on the trial still reopens the circuit (release does not mask it)', async () => {
    vi.useFakeTimers();
    const { client } = createMockClient([
      new FakeApiError('down', 500),
      new FakeApiError('down', 500),
    ]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      baseDelayMs: 1,
      circuitBreaker: { threshold: 1, cooldownMs: 1000 },
    });

    await tripAndCool(llm);
    await expect(llm.call({ userContent: 'x' })).rejects.toBeDefined();

    expect(llm.getCircuitStates()[0]?.state).toBe('open');
  });
});
