import { afterEach, describe, expect, it, vi } from 'vitest';

import { CircuitBreaker } from '../../../src/circuitBreaker.js';
import { createMiddlewareStateBag } from '../../../src/types/index.js';

// Tests switch to fake timers and spies themselves. Restoring here means a failed assertion
// can't leak them into the next test.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CircuitBreaker, multi-probe half-open (unit)', () => {
  function openAndCooldown(cb: CircuitBreaker): void {
    cb.recordFailure();
    vi.advanceTimersByTime(1001);
  }

  it('halfOpenProbes: 1 behaves byte for byte like the current suite (regression guard)', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, halfOpenProbes: 1 });

    openAndCooldown(cb);
    cb.assertClosed();
    expect(cb.getState()).toBe('half-open');
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_trial_in_flight' }),
    );

    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('all three of three probes succeeding closes the circuit', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, halfOpenProbes: 3 });

    openAndCooldown(cb);
    cb.assertClosed();
    cb.assertClosed();
    cb.assertClosed();
    expect(cb.getState()).toBe('half-open');

    cb.recordSuccess();
    cb.recordSuccess();
    expect(cb.getState()).toBe('half-open'); // still waiting on the third
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('two of three succeeding at a 0.5 ratio closes the circuit', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      halfOpenProbes: 3,
      halfOpenSuccessRatio: 0.5,
    });

    openAndCooldown(cb);
    cb.assertClosed();
    cb.assertClosed();
    cb.assertClosed();

    cb.recordSuccess();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('two of three succeeding at a 1.0 ratio reopens the circuit', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      halfOpenProbes: 3,
      halfOpenSuccessRatio: 1,
    });

    openAndCooldown(cb);
    cb.assertClosed();
    cb.assertClosed();
    cb.assertClosed();

    cb.recordSuccess();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.getState()).toBe('open');
  });

  it('a fourth concurrent call while three trials are in flight is rejected with circuit_trial_in_flight', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, halfOpenProbes: 3 });

    openAndCooldown(cb);
    cb.assertClosed();
    cb.assertClosed();
    cb.assertClosed();
    expect(cb.getState()).toBe('half-open');

    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_trial_in_flight' }),
    );
  });

  it('claiming a second half-open trial slot with a context registers a trial permit for it too', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, halfOpenProbes: 2 });

    cb.recordFailure();
    vi.advanceTimersByTime(1001);

    const firstContext = { requestId: 'first', state: createMiddlewareStateBag() };
    const secondContext = { requestId: 'second', state: createMiddlewareStateBag() };

    // First call transitions open -> half-open, claiming slot 1.
    cb.assertClosed(undefined, firstContext);
    expect(cb.getState()).toBe('half-open');

    // Second call claims the remaining slot while already half-open,
    // exercising the trial-permit registration on that branch too.
    cb.assertClosed(undefined, secondContext);

    // Both callers' own contexts settle the same trial they each claimed.
    cb.recordSuccess(undefined, firstContext);
    expect(cb.getState()).toBe('half-open'); // still waiting on the second
    cb.recordSuccess(undefined, secondContext);
    expect(cb.getState()).toBe('closed');
  });

  it('halfOpenProbes clamps to at least 1 when given 0 or a negative number', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, halfOpenProbes: 0 });

    openAndCooldown(cb);
    cb.assertClosed();
    expect(cb.getState()).toBe('half-open');
    // Only one slot, since 0 clamped to 1: a second concurrent call is rejected.
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_trial_in_flight' }),
    );
  });

  it('halfOpenSuccessRatio clamps to [0, 1]', () => {
    vi.useFakeTimers();
    // A ratio above 1 clamps to 1: every probe must succeed.
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      halfOpenProbes: 2,
      halfOpenSuccessRatio: 5,
    });

    openAndCooldown(cb);
    cb.assertClosed();
    cb.assertClosed();
    cb.recordSuccess();
    cb.recordFailure();
    expect(cb.getState()).toBe('open'); // one failure is enough to fail a ratio of 1
  });

  it('halfOpenProbes falls back to the default for non-finite values (NaN, Infinity)', () => {
    vi.useFakeTimers();
    const cbNaN = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, halfOpenProbes: NaN });

    openAndCooldown(cbNaN);
    cbNaN.assertClosed();
    expect(cbNaN.getState()).toBe('half-open');
    // Falls back to the default of 1: a second concurrent call is rejected.
    expect(() => cbNaN.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_trial_in_flight' }),
    );
    cbNaN.recordSuccess();
    expect(cbNaN.getState()).toBe('closed');

    const cbInfinity = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      halfOpenProbes: Infinity,
    });

    openAndCooldown(cbInfinity);
    cbInfinity.assertClosed();
    // Falls back to the default of 1, not an unbounded pool of slots.
    expect(() => cbInfinity.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_trial_in_flight' }),
    );
  });

  it('halfOpenSuccessRatio falls back to the default for non-finite values (NaN, Infinity)', () => {
    vi.useFakeTimers();
    const cbNaN = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      halfOpenProbes: 2,
      halfOpenSuccessRatio: NaN,
    });

    openAndCooldown(cbNaN);
    cbNaN.assertClosed();
    cbNaN.assertClosed();
    cbNaN.recordSuccess();
    cbNaN.recordFailure();
    // Falls back to the default ratio of 1: one failure fails the trial.
    expect(cbNaN.getState()).toBe('open');

    const cbInfinity = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      halfOpenProbes: 2,
      halfOpenSuccessRatio: Infinity,
    });

    openAndCooldown(cbInfinity);
    cbInfinity.assertClosed();
    cbInfinity.assertClosed();
    cbInfinity.recordSuccess();
    cbInfinity.recordSuccess();
    // settleTrialIfComplete still completes correctly with the fallback default.
    expect(cbInfinity.getState()).toBe('closed');
  });

  it('a call admitted while closed that resolves during a later half-open cycle cannot settle that newer trial', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, halfOpenProbes: 1 });
    const staleContext = { requestId: 'stale', state: createMiddlewareStateBag() };

    // Admitted while closed: no trial permit claimed for this call at all.
    cb.assertClosed(undefined, staleContext);
    expect(cb.getState()).toBe('closed');

    // Circuit trips and cools down into a fresh half-open cycle before the
    // stale call above ever resolves.
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.advanceTimersByTime(1001);

    const trialContext = { requestId: 'trial', state: createMiddlewareStateBag() };
    cb.assertClosed(undefined, trialContext);
    expect(cb.getState()).toBe('half-open');

    // The stale call's outcome arrives late. It must not settle the newer
    // trial it never actually claimed a slot in.
    cb.recordSuccess(undefined, staleContext);
    expect(cb.getState()).toBe('half-open');

    // The real trial call still settles the circuit on its own outcome.
    cb.recordSuccess(undefined, trialContext);
    expect(cb.getState()).toBe('closed');
  });
});
