import { describe, it, expect, vi } from 'vitest';

import { CircuitBreaker } from '../../src/circuitBreaker.js';
import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse } from './../helpers.js';

describe('CircuitBreaker (unit)', () => {
  it('starts closed', () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe('closed');
    expect(() => cb.assertClosed()).not.toThrow();
  });

  it('opens after `threshold` consecutive failures', () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000 });
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });

  it('throws LLMError(circuit_open) while open and within cooldown', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 10_000 });
    cb.recordFailure();
    expect(() => cb.assertClosed()).toThrow(expect.objectContaining({ type: 'circuit_open' }));
  });

  it('resets consecutive failures on success', () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000 });
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed'); // only 1 consecutive failure since reset
  });

  it('transitions to half-open after cooldown elapses, and closes on a successful trial', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });
    cb.recordFailure();
    expect(cb.getState()).toBe('open');

    vi.advanceTimersByTime(1001);
    expect(() => cb.assertClosed()).not.toThrow();
    expect(cb.getState()).toBe('half-open');

    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
    vi.useRealTimers();
  });

  it('reopens if the half-open trial call fails', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });
    cb.recordFailure();
    vi.advanceTimersByTime(1001);
    cb.assertClosed(); // -> half-open
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.useRealTimers();
  });
});

describe('VernLLM — circuit breaker integration', () => {
  it('is undefined by default (opt-in)', () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });
    expect(llm.getCircuitState()).toBeUndefined();
  });

  it('records exactly one failure per failed call() — not one per attempt', async () => {
    const { client } = createMockClient([new Error('a'), new Error('b')]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 1, // 2 attempts per call()
      baseDelayMs: 0,
      circuitBreaker: { threshold: 3, cooldownMs: 1000 },
    });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});
    // Both attempts failed within a single call() — breaker should register
    // this as ONE consecutive failure, not two (regression test for a bug
    // where recordFailure() was invoked both in the catch block and again
    // after the loop).
    expect(llm.getCircuitState()).toBe('closed');
  });

  it('opens after enough failed call()s and blocks further calls with circuit_open', async () => {
    const { client, create } = createMockClient([new Error('down')]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 2, cooldownMs: 10_000 },
    });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});
    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});
    expect(llm.getCircuitState()).toBe('open');

    const callCountBefore = create.mock.calls.length;
    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).rejects.toMatchObject({
      type: 'circuit_open',
    });
    // The blocked call should not have reached the client at all.
    expect(create.mock.calls.length).toBe(callCountBefore);
  });

  it('closes again after a successful call', async () => {
    const { client } = createMockClient([new Error('down'), jsonResponse({ ok: true })]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 5, cooldownMs: 1000 },
    });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});
    await llm.call({ systemPrompt: 's', userContent: 'u' });
    expect(llm.getCircuitState()).toBe('closed');
  });
});
