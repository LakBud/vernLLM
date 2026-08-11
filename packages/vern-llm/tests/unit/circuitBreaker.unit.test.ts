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
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, onStateChange });

    cb.recordFailure();

    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 1, undefined);
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
});
