import { describe, it, expect, vi } from 'vitest';

import { CircuitBreaker } from '../../src/circuitBreaker.js';
import { FallbackExhaustedError } from '../../src/types/fallback.js';
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

  it('rejects concurrent callers during half-open, letting only the first through as the trial', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });
    cb.recordFailure();
    vi.advanceTimersByTime(1001);

    // First caller becomes the trial and is allowed through
    expect(() => cb.assertClosed()).not.toThrow();
    expect(cb.getState()).toBe('half-open');

    // Every other concurrent caller is rejected while the trial is outstanding
    expect(() => cb.assertClosed()).toThrow(expect.objectContaining({ type: 'circuit_open' }));
    expect(() => cb.assertClosed()).toThrow(expect.objectContaining({ type: 'circuit_open' }));

    vi.useRealTimers();
  });

  it('allows a new trial once the outstanding half-open trial is recorded (success)', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });
    cb.recordFailure();
    vi.advanceTimersByTime(1001);

    cb.assertClosed(); // trial 1 starts
    expect(() => cb.assertClosed()).toThrow(expect.objectContaining({ type: 'circuit_open' })); // blocked while trial 1 is in flight

    cb.recordSuccess(); // trial 1 resolves, circuit closes
    expect(() => cb.assertClosed()).not.toThrow(); // closed circuit, no gating needed

    vi.useRealTimers();
  });

  it('allows a new trial once the outstanding half-open trial is recorded (failure)', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });
    cb.recordFailure();
    vi.advanceTimersByTime(1001);

    cb.assertClosed(); // trial 1 starts
    expect(() => cb.assertClosed()).toThrow(); // blocked while trial 1 is in flight

    cb.recordFailure(); // trial 1 fails, circuit reopens with a fresh cooldown
    expect(cb.getState()).toBe('open');
    expect(() => cb.assertClosed()).toThrow(expect.objectContaining({ type: 'circuit_open' }));

    vi.advanceTimersByTime(1001);
    expect(() => cb.assertClosed()).not.toThrow(); // new cooldown elapsed, new trial allowed
    expect(cb.getState()).toBe('half-open');

    vi.useRealTimers();
  });

  it('reports the model passed to the call that triggered a transition, via onStateChange', () => {
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, onStateChange });

    cb.recordFailure('gpt-4o');

    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 1, 'gpt-4o');
  });

  it('reports whichever model most recently touched the breaker, even across different models', () => {
    // The breaker's failure count stays shared across every model; only
    // the *label* on the emitted transition reflects the triggering call.
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000, onStateChange });

    cb.recordFailure('gpt-4o'); // 1st failure, no transition yet
    cb.recordFailure('gpt-4o-mini'); // 2nd failure, crosses threshold

    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 2, 'gpt-4o-mini');
  });

  it('omitting `model` on record/assert calls reports undefined, not a stale prior value', () => {
    vi.useFakeTimers();
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, onStateChange });

    cb.recordFailure();
    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 1, undefined);

    // Also cover assertClosed's own transition (open -> half-open),
    // the test's title mentions "assert calls" but only recordFailure
    // was previously exercised.
    vi.advanceTimersByTime(1001);
    cb.assertClosed();
    expect(onStateChange).toHaveBeenCalledWith('open', 'half-open', 1, undefined);

    vi.useRealTimers();
  });
});

describe('CircuitBreaker, isolateByModel (unit)', () => {
  it('defaults to off: a single shared circuit, unchanged from every prior version', () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000 });

    cb.recordFailure('gpt-4o');
    cb.recordFailure('gpt-4o-mini'); // crosses threshold, mixed across models

    expect(cb.getState('gpt-4o')).toBe('open');
    expect(cb.getState('gpt-4o-mini')).toBe('open');
    expect(cb.getState()).toBe('open');
  });

  it('isolates failure counts per model: one model opening does not affect another', () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000, isolateByModel: true });

    cb.recordFailure('gpt-4o');
    cb.recordFailure('gpt-4o'); // crosses threshold for gpt-4o only

    expect(cb.getState('gpt-4o')).toBe('open');
    expect(cb.getState('gpt-4o-mini')).toBe('closed'); // untouched
  });

  it('a model never seen yet reports "closed", same as a fresh breaker', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, isolateByModel: true });

    expect(cb.getState('never-called')).toBe('closed');
  });

  it('does not allocate a bucket for an unseen model when reading state', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, isolateByModel: true });
    const buckets = (cb as unknown as { bucketsByModel: Map<string, unknown> }).bucketsByModel;

    expect(cb.getState('never-called')).toBe('closed');
    expect(buckets.size).toBe(0);
  });

  it('evicts a model bucket once it returns to a pristine closed state', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, isolateByModel: true });
    const buckets = (cb as unknown as { bucketsByModel: Map<string, unknown> }).bucketsByModel;

    cb.recordFailure('gpt-4o');
    expect(buckets.size).toBe(1);

    cb.recordSuccess('gpt-4o');
    expect(cb.getState('gpt-4o')).toBe('closed');
    expect(buckets.size).toBe(0);
  });

  it('assertClosed throws only for the model whose bucket is open', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 10_000, isolateByModel: true });

    cb.recordFailure('gpt-4o');

    expect(() => cb.assertClosed('gpt-4o')).toThrow(
      expect.objectContaining({ type: 'circuit_open' }),
    );
    expect(() => cb.assertClosed('gpt-4o-mini')).not.toThrow();
  });

  it('a call omitting `model` falls into one shared bucket, separate from every named model', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, isolateByModel: true });

    cb.recordFailure(); // no model given

    expect(cb.getState()).toBe('open');
    expect(cb.getState('gpt-4o')).toBe('closed'); // a real model is unaffected
  });

  it('onStateChange reports the exact model that triggered each isolated transition', () => {
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      isolateByModel: true,
      onStateChange,
    });

    cb.recordFailure('gpt-4o');
    cb.recordFailure('gpt-4o-mini');

    expect(onStateChange).toHaveBeenCalledTimes(2);
    expect(onStateChange).toHaveBeenNthCalledWith(1, 'closed', 'open', 1, 'gpt-4o');
    expect(onStateChange).toHaveBeenNthCalledWith(2, 'closed', 'open', 1, 'gpt-4o-mini');
  });

  it('half-open/cooldown/trial-in-flight semantics are unchanged, just scoped per model', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, isolateByModel: true });

    cb.recordFailure('gpt-4o');
    expect(cb.getState('gpt-4o')).toBe('open');

    vi.advanceTimersByTime(1001);
    expect(() => cb.assertClosed('gpt-4o')).not.toThrow(); // becomes the trial
    expect(cb.getState('gpt-4o')).toBe('half-open');
    expect(() => cb.assertClosed('gpt-4o')).toThrow(
      expect.objectContaining({ type: 'circuit_open' }),
    ); // trial in flight

    // A different model was never touched, so it's unaffected by gpt-4o's cooldown/trial state.
    expect(() => cb.assertClosed('gpt-4o-mini')).not.toThrow();

    cb.recordSuccess('gpt-4o');
    expect(cb.getState('gpt-4o')).toBe('closed');

    vi.useRealTimers();
  });
});

describe('VernLLM, circuit breaker integration', () => {
  it('is undefined by default (opt-in)', () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });
    expect(llm.getCircuitState()).toBeUndefined();
  });

  it('records exactly one failure per failed call(), not one per attempt', async () => {
    const { client } = createMockClient([new Error('a'), new Error('b')]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 1, // 2 attempts per call()
      baseDelayMs: 0,
      circuitBreaker: { threshold: 3, cooldownMs: 1000 },
    });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});
    // Both attempts failed within a single call(), breaker should register
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

  it('does not reserve usage for a blocked call when the sole target is open, fails fast before reserving', async () => {
    const { client, create } = createMockClient([new Error('down')]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
    });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});
    expect(llm.getCircuitState()).toBe('open');

    const reserveUsage = vi.fn();
    const refundUsage = vi.fn();
    const callCountBefore = create.mock.calls.length;

    await expect(
      llm.call({ systemPrompt: 's', userContent: 'u', reserveUsage, refundUsage }),
    ).rejects.toMatchObject({ type: 'circuit_open' });

    expect(reserveUsage).not.toHaveBeenCalled();
    expect(refundUsage).not.toHaveBeenCalled();
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

  it('lets only one trial call reach the provider when several calls race right as cooldown ends', async () => {
    vi.useFakeTimers();

    let resolveTrial!: () => void;
    const trialGate = new Promise<void>((resolve) => {
      resolveTrial = resolve;
    });

    const { client, create } = createMockClient([
      new Error('down'), // opens the circuit
      async () => {
        // The trial call hangs until we release it, so concurrent callers
        // firing while it's outstanding have a real window to race against it
        await trialGate;
        return jsonResponse({ ok: true });
      },
    ]);

    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 1000 },
    });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});
    expect(llm.getCircuitState()).toBe('open');

    vi.advanceTimersByTime(1001); // cooldown elapses

    // Fire several concurrent calls at once, right as the circuit becomes eligible for a trial
    const trialPromise = llm.call({ systemPrompt: 's', userContent: 'u' });
    // Give the first call a chance to become the trial before firing the rest
    await Promise.resolve();
    const rejectedPromises = [
      llm.call({ systemPrompt: 's', userContent: 'u' }),
      llm.call({ systemPrompt: 's', userContent: 'u' }),
    ];

    // The two concurrent callers should be rejected immediately, without
    // waiting on the outstanding trial
    const rejectedResults = await Promise.allSettled(rejectedPromises);
    expect(rejectedResults.every((r) => r.status === 'rejected')).toBe(true);
    for (const r of rejectedResults) {
      if (r.status === 'rejected') {
        expect(r.reason).toMatchObject({ type: 'circuit_open' });
      }
    }

    // Only the trial call should have reached the provider (1 open-circuit call + 1 trial call)
    expect(create.mock.calls.length).toBe(2);

    resolveTrial();
    await expect(trialPromise).resolves.toEqual({ ok: true });
    expect(llm.getCircuitState()).toBe('closed');

    vi.useRealTimers();
  });

  it('does not open the breaker on a parse failure', async () => {
    const { client } = createMockClient([{ choices: [{ message: { content: '{invalid json' } }] }]);

    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    await expect(
      llm.call({
        systemPrompt: 's',
        userContent: 'u',
      }),
    ).rejects.toMatchObject({
      type: 'parse',
    });

    expect(llm.getCircuitState()).toBe('closed');
  });

  it('does not open the breaker on a schema-validation failure', async () => {
    const { client } = createMockClient([jsonResponse({ wrong: 'shape' })]);

    const schema = {
      safeParse(
        value: unknown,
      ):
        | { success: true; data: object & { expected: unknown } }
        | { success: false; error: unknown } {
        if (typeof value === 'object' && value !== null && 'expected' in value) {
          return {
            success: true,
            data: value as object & { expected: unknown },
          };
        }

        return {
          success: false,
          error: { message: 'missing expected field' },
        };
      },
    };

    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    await expect(
      llm.call({
        systemPrompt: 's',
        userContent: 'u',
        schema,
      }),
    ).rejects.toMatchObject({
      type: 'validation',
    });

    expect(llm.getCircuitState()).toBe('closed');
  });

  it('returns circuit state for every target in the fallback chain', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      },
    });

    expect(llm.getCircuitStates()).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: false, state: 'closed' },
      { provider: 'fallback', index: 1, isFallback: true, isolateByModel: false, state: 'closed' },
    ]);
  });

  it('reports fallback circuit state independently from the primary', async () => {
    const { client: primaryClient } = createMockClient([new Error('primary down')]);
    const { client: fallbackClient } = createMockClient([new Error('fallback down')]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      },
    });

    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).rejects.toBeInstanceOf(
      FallbackExhaustedError,
    );

    expect(llm.getCircuitStates()).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: false, state: 'open' },
      { provider: 'fallback', index: 1, isFallback: true, isolateByModel: false, state: 'open' },
    ]);
  });

  it('returns undefined state for targets without a circuit breaker', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        // No circuit breaker.
      },
    });

    expect(llm.getCircuitStates()).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: false, state: 'closed' },
      { provider: 'fallback', index: 1, isFallback: true, isolateByModel: false, state: undefined },
    ]);
  });

  it("isolateByModel on getCircuitStates entries reflects each target's own breaker config", () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'gpt-4o',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true },
      fallback: {
        client: fallbackClient,
        model: 'claude-sonnet',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 }, // isolateByModel off
      },
    });

    expect(llm.getCircuitStates()).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: true, state: 'closed' },
      { provider: 'fallback', index: 1, isFallback: true, isolateByModel: false, state: 'closed' },
    ]);
  });

  it('getCircuitState() delegates to getCircuitStates() and defaults to the primary target', () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({
      client,
      model: 'm',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    expect(llm.getCircuitState()).toBe('closed');
    expect(llm.getCircuitState({})).toBe('closed');
  });

  it('getCircuitState({ index }) reaches a fallback target', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([new Error('fallback down')]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      circuitBreaker: { threshold: 5, cooldownMs: 10_000 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        maxRetries: 0,
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      },
    });

    expect(llm.getCircuitState({ index: 1 })).toBe('closed');
  });

  it('getCircuitState({ index }) scopes model to the resolved target only', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'gpt-4o',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true },
      fallback: {
        client: fallbackClient,
        model: 'claude-sonnet',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true },
      },
    });

    llm.openCircuit({ index: 0, model: 'gpt-4o' });

    expect(llm.getCircuitState({ index: 0, model: 'gpt-4o' })).toBe('open');
    expect(llm.getCircuitState({ index: 0, model: 'gpt-4o-mini' })).toBe('closed');
    expect(llm.getCircuitState({ index: 1, model: 'gpt-4o' })).toBe('closed');
  });

  it('getCircuitState warns (but still returns a value) when model is passed but the target has no isolateByModel', () => {
    const { client } = createMockClient([]);
    const warn = vi.fn();
    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 }, // isolateByModel off
      logger: { debug: vi.fn(), warn, error: vi.fn() },
    });

    expect(llm.getCircuitState({ model: 'gpt-4o' })).toBe('closed'); // shared bucket, not thrown
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('getCircuitState');
    expect(warn.mock.calls[0]![0]).toContain("model: 'gpt-4o'");

    // Bare, model-less calls on the same target don't warn at all.
    warn.mockClear();
    expect(llm.getCircuitState()).toBe('closed');
    expect(warn).not.toHaveBeenCalled();
  });

  it('openCircuit/closeCircuit warn (but still act on the shared bucket) for an unsupported model', () => {
    const { client } = createMockClient([]);
    const warn = vi.fn();
    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 }, // isolateByModel off
      logger: { debug: vi.fn(), warn, error: vi.fn() },
    });

    expect(() => llm.openCircuit({ model: 'gpt-4o' })).not.toThrow();
    expect(llm.getCircuitState()).toBe('open'); // shared bucket, not a no-op
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('openCircuit');

    warn.mockClear();
    expect(() => llm.closeCircuit({ model: 'gpt-4o' })).not.toThrow();
    expect(llm.getCircuitState()).toBe('closed');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('closeCircuit');
  });

  it('getCircuitState warns when model is passed but the target has no breaker at all', () => {
    const { client } = createMockClient([]);
    const warn = vi.fn();
    const llm = new VernLLM({
      client,
      model: 'm',
      logger: { debug: vi.fn(), warn, error: vi.fn() },
    }); // no circuitBreaker option

    expect(llm.getCircuitState({ model: 'gpt-4o' })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('the model-unsupported warning only fires for the target `index` actually resolves to', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);
    const warn = vi.fn();

    const llm = new VernLLM({
      client: primaryClient,
      model: 'gpt-4o',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true }, // isolates
      fallback: {
        client: fallbackClient,
        model: 'claude-sonnet',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 }, // does not isolate
      },
      logger: { debug: vi.fn(), warn, error: vi.fn() },
    });

    // Primary isolates: model is fine there, no warning.
    llm.getCircuitState({ index: 0, model: 'gpt-4o' });
    expect(warn).not.toHaveBeenCalled();

    // Fallback doesn't isolate: same-shaped call now warns, since it's
    // being asked of a different target with a different config.
    llm.getCircuitState({ index: 1, model: 'claude-sonnet' });
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();

    // Same split holds for openCircuit/closeCircuit, not just reads.
    llm.openCircuit({ index: 0, model: 'gpt-4o' });
    expect(warn).not.toHaveBeenCalled();

    llm.openCircuit({ index: 1, model: 'claude-sonnet' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('index is validated before model: an out-of-range index still throws RangeError even with an unsupported model', () => {
    const { client } = createMockClient([]);
    const warn = vi.fn();
    const llm = new VernLLM({
      client,
      model: 'm',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 }, // isolateByModel off too
      logger: { debug: vi.fn(), warn, error: vi.fn() },
    });

    // Both `index` and `model` are "wrong" here; index should be reported
    // first, and the model check should never even run.
    expect(() => llm.getCircuitState({ index: 9, model: 'gpt-4o' })).toThrow(RangeError);
    expect(() => llm.openCircuit({ index: 9, model: 'gpt-4o' })).toThrow(RangeError);

    expect(() => llm.closeCircuit({ index: 9, model: 'gpt-4o' })).toThrow(RangeError);
  });

  it('getCircuitStates() stays permissive: model is safely ignored on non-isolating targets, no throw', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'gpt-4o',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true },
      fallback: {
        client: fallbackClient,
        model: 'claude-sonnet',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 }, // does not isolate
      },
    });

    // Sweeping `model` across a mixed chain is exactly what getCircuitStates
    // is for — it must never throw just because one target ignores it.
    expect(() => llm.getCircuitStates('gpt-4o')).not.toThrow();
    expect(llm.getCircuitStates('gpt-4o')).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: true, state: 'closed' },
      { provider: 'fallback', index: 1, isFallback: true, isolateByModel: false, state: 'closed' },
    ]);
  });

  it('getCircuitState throws RangeError for an out-of-range index, distinct from a real target with no breaker', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        // No circuit breaker on the fallback — a real target, just untracked.
      },
    });

    // Real target, no breaker: a legitimate `undefined`, not an error.
    expect(llm.getCircuitState({ index: 1 })).toBeUndefined();

    // No target at all at this index: distinguishable via a thrown error.
    expect(() => llm.getCircuitState({ index: 2 })).toThrow(RangeError);
    expect(() => llm.getCircuitState({ index: -1 })).toThrow(RangeError);
  });

  it('openCircuit()/closeCircuit() default to the primary target', () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({
      client,
      model: 'm',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    llm.openCircuit();
    expect(llm.getCircuitState()).toBe('open');

    llm.closeCircuit();
    expect(llm.getCircuitState()).toBe('closed');
  });

  it('openCircuit({ index })/closeCircuit({ index }) reach a fallback target', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      },
    });

    llm.openCircuit({ index: 1 });
    expect(llm.getCircuitStates()).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: false, state: 'closed' },
      { provider: 'fallback', index: 1, isFallback: true, isolateByModel: false, state: 'open' },
    ]);

    llm.closeCircuit({ index: 1 });
    expect(llm.getCircuitStates()).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: false, state: 'closed' },
      { provider: 'fallback', index: 1, isFallback: true, isolateByModel: false, state: 'closed' },
    ]);
  });

  it('openCircuit/closeCircuit throw RangeError for an out-of-range index, same as getCircuitState', () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({
      client,
      model: 'm',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    expect(() => llm.openCircuit({ index: 5 })).toThrow(RangeError);
    expect(() => llm.closeCircuit({ index: 5 })).toThrow(RangeError);
    // Confirm it's a no-op, not a partial mutation before the throw.
    expect(llm.getCircuitState()).toBe('closed');
  });

  it('openCircuit/closeCircuit throw RangeError for a negative index', () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({
      client,
      model: 'm',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    expect(() => llm.openCircuit({ index: -1 })).toThrow(RangeError);
    expect(() => llm.closeCircuit({ index: -1 })).toThrow(RangeError);
    expect(llm.getCircuitState()).toBe('closed');
  });

  it('RangeError message names the failing method and reports the actual chain size', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      },
    });

    // Chain has 2 targets (primary + one fallback): index 2 is the first invalid one.
    expect(() => llm.getCircuitState({ index: 2 })).toThrow(/no target at index 2.*2 targets/);
    expect(() => llm.openCircuit({ index: 2 })).toThrow(/openCircuit.*no target at index 2/);
    expect(() => llm.closeCircuit({ index: 2 })).toThrow(/closeCircuit.*no target at index 2/);
  });

  it('RangeError message uses singular "target" for a chain with no fallback configured', () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({ client, model: 'm' }); // no fallback: chain has exactly 1 target

    expect(() => llm.getCircuitState({ index: 1 })).toThrow(/1 target\)/);
    expect(() => llm.getCircuitState({ index: 1 })).not.toThrow(/1 targets\)/);
  });

  it('an out-of-range index on one call does not affect a valid index on the next', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      },
    });

    expect(() => llm.openCircuit({ index: 9 })).toThrow(RangeError);
    // The library's own internal state (executors array, etc.) is untouched
    // by a rejected call. A subsequent valid call still works normally.
    llm.openCircuit({ index: 1 });
    expect(llm.getCircuitState({ index: 1 })).toBe('open');
  });

  it('openCircuit/closeCircuit are no-ops (not throws) when no circuit breaker is configured', () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({ client, model: 'm' }); // no circuitBreaker option

    expect(() => llm.openCircuit()).not.toThrow();
    expect(() => llm.closeCircuit()).not.toThrow();
    expect(llm.getCircuitState()).toBeUndefined();
  });
});
