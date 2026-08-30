import { describe, it, expect, vi } from 'vitest';

import { CircuitBreaker } from '../../src/circuitBreaker.js';
import { FallbackExhaustedError } from '../../src/types/fallback.js';
import { createMiddlewareStateBag, type VernLLMMiddleware } from '../../src/types/index.js';
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

  it('behaves exactly as before when recordFailure is called with no third argument', () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000 });
    cb.recordFailure(undefined, undefined);
    expect(cb.getState()).toBe('closed');
    cb.recordFailure(undefined, undefined);
    expect(cb.getState()).toBe('open');
  });

  it('accepts an optional code argument without throwing or changing trip behavior', () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000 });
    expect(() => cb.recordFailure(undefined, undefined, 'server_error')).not.toThrow();
    cb.recordFailure(undefined, undefined, 'server_error');
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

    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 1, 'gpt-4o', undefined);
  });

  it('reports whichever model most recently touched the breaker, even across different models', () => {
    // The breaker's failure count stays shared across every model; only
    // the *label* on the emitted transition reflects the triggering call.
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000, onStateChange });

    cb.recordFailure('gpt-4o'); // 1st failure, no transition yet
    cb.recordFailure('gpt-4o-mini'); // 2nd failure, crosses threshold

    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 2, 'gpt-4o-mini', undefined);
  });

  it('omitting `model` on record/assert calls reports undefined, not a stale prior value', () => {
    vi.useFakeTimers();
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, onStateChange });

    cb.recordFailure();
    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 1, undefined, undefined);

    // Also cover assertClosed's own transition (open -> half-open),
    // the test's title mentions "assert calls" but only recordFailure
    // was previously exercised.
    vi.advanceTimersByTime(1001);
    cb.assertClosed();
    expect(onStateChange).toHaveBeenCalledWith('open', 'half-open', 1, undefined, undefined);

    vi.useRealTimers();
  });
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

    vi.useRealTimers();
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

    vi.useRealTimers();
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

    vi.useRealTimers();
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

    vi.useRealTimers();
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

    vi.useRealTimers();
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

    vi.useRealTimers();
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

    vi.useRealTimers();
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

    vi.useRealTimers();
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

    vi.useRealTimers();
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

    vi.useRealTimers();
  });
});

describe('CircuitBreaker, cooldown backoff (unit)', () => {
  it('no cooldownBackoff reproduces the current fixed cooldown, unmodified', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });

    cb.recordFailure();
    vi.advanceTimersByTime(999);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(2);
    expect(() => cb.assertClosed()).not.toThrow();
    expect(cb.getState()).toBe('half-open');

    // Reopen via a failed trial, cooldown should still be the same
    // fixed 1000ms, not grown, since no cooldownBackoff is configured.
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.advanceTimersByTime(999);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(2);
    expect(() => cb.assertClosed()).not.toThrow();

    vi.useRealTimers();
  });

  it('the shorthand always applies jitter: falls in [exp/2, exp], not the exact value', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      cooldownBackoff: { multiplier: 2 },
    });

    // First open: reopenCount 0, exp = 1000 * 2^0 = 1000, jittered to [500, 1000].
    cb.recordFailure();
    // Below the floor of the jittered range: never admitted.
    vi.advanceTimersByTime(499);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    // Past the ceiling of the jittered range: always admitted, regardless of the actual roll.
    vi.advanceTimersByTime(501);
    expect(() => cb.assertClosed()).not.toThrow();
    expect(cb.getState()).toBe('half-open');

    vi.useRealTimers();
  });

  it('the jittered cooldown is sampled once per open period, not resampled on every assertClosed check', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 10_000,
      cooldownBackoff: { multiplier: 2 },
    });

    cb.recordFailure();

    const messages: string[] = [];
    for (let i = 0; i < 20; i++) {
      try {
        cb.assertClosed();
      } catch (error) {
        messages.push((error as Error).message);
      }
    }

    // Every check above happened at the same elapsed time (0ms since
    // open, no time advanced between calls). The jittered range here
    // spans several whole seconds ([5000, 10000]ms), so if the cooldown
    // were resampled per check, the reported "Retry in Xs" would very
    // likely differ across the 20 draws. Sampled once and cached, every
    // check reports the identical wait.
    expect(messages).toHaveLength(20);
    expect(new Set(messages).size).toBe(1);

    vi.useRealTimers();
  });

  it('a custom function is never jittered automatically, jitter only applies to the shorthand', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      cooldownBackoff: () => 1000, // fixed, no jitter applied by the library
    });

    cb.recordFailure();
    vi.advanceTimersByTime(999);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(2);
    expect(() => cb.assertClosed()).not.toThrow();

    vi.useRealTimers();
  });

  it('the { multiplier, maxMs } shorthand grows the jittered range across three reopen cycles', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      cooldownBackoff: { multiplier: 2 },
    });

    // First open: reopenCount 0, exp = 1000 * 2^0 = 1000, jittered range [500, 1000].
    cb.recordFailure();
    vi.advanceTimersByTime(499);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(501); // total 1000, past the ceiling
    cb.assertClosed();
    expect(cb.getState()).toBe('half-open');

    // Trial fails: reopenCount 1, exp = 1000 * 2^1 = 2000, jittered range [1000, 2000].
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.advanceTimersByTime(999);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(1001); // total 2000, past the ceiling
    cb.assertClosed();
    expect(cb.getState()).toBe('half-open');

    // Trial fails again: reopenCount 2, exp = 1000 * 2^2 = 4000, jittered range [2000, 4000].
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.advanceTimersByTime(1999);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(2001); // total 4000, past the ceiling
    cb.assertClosed();
    expect(cb.getState()).toBe('half-open');

    vi.useRealTimers();
  });

  it('maxMs caps the growth, including the jittered range', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      cooldownBackoff: { multiplier: 10, maxMs: 5000 },
    });

    // First open: reopenCount 0, exp = 1000 * 10^0 = 1000, admit by 1000ms.
    cb.recordFailure();
    vi.advanceTimersByTime(1000);
    cb.assertClosed();

    // Trial fails: reopenCount 1, uncapped exp would be 10000, capped to
    // 5000, jittered range [2500, 5000].
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.advanceTimersByTime(2499);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(2501); // total 5000, past the capped ceiling
    expect(() => cb.assertClosed()).not.toThrow();

    vi.useRealTimers();
  });

  it('a custom linear backoff function, passed directly rather than the shorthand, is honored exactly', () => {
    vi.useFakeTimers();
    const linear = (reopenCount: number, baseCooldownMs: number): number =>
      baseCooldownMs + reopenCount * 500;
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, cooldownBackoff: linear });

    // First open: reopenCount 0, cooldown 1000 + 0 * 500 = 1000.
    cb.recordFailure();
    vi.advanceTimersByTime(1001);
    cb.assertClosed();

    // Trial fails: reopenCount 1, cooldown 1000 + 1 * 500 = 1500.
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.advanceTimersByTime(1499);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(2);
    expect(() => cb.assertClosed()).not.toThrow();

    vi.useRealTimers();
  });

  it('a backoff function returning a negative number is clamped to 0', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      cooldownBackoff: () => -500,
    });

    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    // Clamped to 0: no wait at all, admits a trial immediately.
    expect(() => cb.assertClosed()).not.toThrow();
    expect(cb.getState()).toBe('half-open');

    vi.useRealTimers();
  });

  it('recordSuccess resets reopenCount, so a later reopen starts the backoff over', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      cooldownBackoff: { multiplier: 2 },
    });

    // Open, reopen once via a failed trial (reopenCount -> 1, jittered
    // range [1000, 2000]), then recover with a successful trial, which
    // should reset reopenCount.
    cb.recordFailure();
    vi.advanceTimersByTime(1000); // reopenCount 0 ceiling
    cb.assertClosed();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.advanceTimersByTime(2000); // reopenCount 1 ceiling
    cb.assertClosed();
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');

    // Trip again: reopenCount should be back to 0, so the jittered
    // range is [500, 1000] again, not a continuation of the earlier
    // growth ([1000, 2000] or beyond).
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    vi.advanceTimersByTime(499);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(501); // total 1000, past the reset ceiling
    expect(() => cb.assertClosed()).not.toThrow();

    vi.useRealTimers();
  });
});

describe('CircuitBreaker, failure attribution (unit)', () => {
  it('repeated failures with different codes produce a correct breakdown', () => {
    const cb = new CircuitBreaker({ threshold: 10 });

    cb.recordFailure(undefined, undefined, 'server_error');
    cb.recordFailure(undefined, undefined, 'server_error');
    cb.recordFailure(undefined, undefined, 'request_timeout');

    expect(cb.getFailureBreakdown()).toEqual({ server_error: 2, request_timeout: 1 });
  });

  it('an error with no code attributes to "unknown"', () => {
    const cb = new CircuitBreaker({ threshold: 10 });

    cb.recordFailure();
    cb.recordFailure(undefined, undefined, 'server_error');

    expect(cb.getFailureBreakdown()).toEqual({ unknown: 1, server_error: 1 });
  });

  it('breakdown clears on success', () => {
    const cb = new CircuitBreaker({ threshold: 10 });

    cb.recordFailure(undefined, undefined, 'server_error');
    expect(cb.getFailureBreakdown()).toEqual({ server_error: 1 });

    cb.recordSuccess();
    expect(cb.getFailureBreakdown()).toEqual({});
  });

  it('breakdown clears on manual close()', () => {
    const cb = new CircuitBreaker({ threshold: 10 });

    cb.recordFailure(undefined, undefined, 'server_error');
    cb.close();

    expect(cb.getFailureBreakdown()).toEqual({});
  });

  it('breakdown clears when a half-open trial succeeds and closes the circuit', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });

    cb.recordFailure(undefined, undefined, 'server_error');
    vi.advanceTimersByTime(1001);
    cb.assertClosed();
    cb.recordSuccess();

    expect(cb.getFailureBreakdown()).toEqual({});

    vi.useRealTimers();
  });

  it('a trial failure that reopens the circuit still attributes, and prior failures survive since the bucket never closed', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });

    cb.recordFailure(undefined, undefined, 'server_error');
    vi.advanceTimersByTime(1001);
    cb.assertClosed();
    cb.recordFailure(undefined, undefined, 'request_timeout');

    expect(cb.getState()).toBe('open');
    expect(cb.getFailureBreakdown()).toEqual({ server_error: 1, request_timeout: 1 });

    vi.useRealTimers();
  });

  it('isolateByModel keeps breakdowns per model', () => {
    const cb = new CircuitBreaker({ threshold: 10, isolateByModel: true });

    cb.recordFailure('gpt-4o', undefined, 'server_error');
    cb.recordFailure('gpt-4o-mini', undefined, 'request_timeout');
    cb.recordFailure('gpt-4o-mini', undefined, 'request_timeout');

    expect(cb.getFailureBreakdown('gpt-4o')).toEqual({ server_error: 1 });
    expect(cb.getFailureBreakdown('gpt-4o-mini')).toEqual({ request_timeout: 2 });
  });

  it('getFailureBreakdown returns an empty object for a model that never failed', () => {
    const cb = new CircuitBreaker({ threshold: 10, isolateByModel: true });

    expect(cb.getFailureBreakdown('never-called')).toEqual({});
  });

  it("a stale trial permit's failure is ignored entirely, including attribution", () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });
    const staleContext = { requestId: 'stale', state: createMiddlewareStateBag() };

    // Admitted while closed: no trial permit claimed for this call at all.
    cb.assertClosed(undefined, staleContext);

    cb.recordFailure(); // trips the circuit for real
    vi.advanceTimersByTime(1001);

    const trialContext = { requestId: 'trial', state: createMiddlewareStateBag() };
    cb.assertClosed(undefined, trialContext);
    expect(cb.getState()).toBe('half-open');

    // The stale call's failure arrives late, after the real trial began.
    // It must not be attributed, since it was never part of this trial.
    cb.recordFailure(undefined, staleContext, 'server_error');
    expect(cb.getFailureBreakdown()).toEqual({ unknown: 1 });

    vi.useRealTimers();
  });

  it('getFailureBreakdown returns a plain object copy, not a live reference', () => {
    const cb = new CircuitBreaker({ threshold: 10 });

    cb.recordFailure(undefined, undefined, 'server_error');
    const breakdown = cb.getFailureBreakdown();
    breakdown.server_error = 999;

    expect(cb.getFailureBreakdown()).toEqual({ server_error: 1 });
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

  it('close() does not evict a bucket a synchronous onStateChange callback just reopened', () => {
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      isolateByModel: true,
      onStateChange: (_from, to) => {
        if (to === 'closed') {
          cb.open('gpt-4o'); // re-enters synchronously before close() returns
        }
      },
    });
    const buckets = (cb as unknown as { bucketsByModel: Map<string, unknown> }).bucketsByModel;

    cb.recordFailure('gpt-4o');
    expect(buckets.size).toBe(1);

    cb.close('gpt-4o');

    expect(cb.getState('gpt-4o')).toBe('open');
    expect(buckets.size).toBe(1);
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
    expect(onStateChange).toHaveBeenNthCalledWith(1, 'closed', 'open', 1, 'gpt-4o', undefined);
    expect(onStateChange).toHaveBeenNthCalledWith(2, 'closed', 'open', 1, 'gpt-4o-mini', undefined);
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

  it("a signal that aborts during a slow wrap, before assertBreakerClosed runs, doesn't leak the half-open trial slot", async () => {
    const { client } = createMockClient([new Error('down'), jsonResponse({ ok: true })]);

    let gate: Promise<void> = Promise.resolve();
    let releaseGate: (() => void) | undefined;
    const armGate = () => {
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    };

    const slowWrap: VernLLMMiddleware = {
      name: 'slow',
      wrap: async (_request, next) => {
        await gate;
        return next();
      },
    };

    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 1 },
      middleware: [slowWrap],
    });

    // Trip the breaker open.
    await llm.call({ systemPrompt: 's', userContent: 'first' }).catch(() => {});
    expect(llm.getCircuitState()).toBe('open');

    // Wait past cooldown so the circuit is eligible for a half-open trial.
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Start a trial call and abort it while `wrap` is still delaying, i.e.
    // before `assertBreakerClosed` (inside `coreOperation`) has run at all.
    armGate();
    const controller = new AbortController();
    const trialPromise = llm.call({
      systemPrompt: 's',
      userContent: 'trial',
      signal: controller.signal,
    });

    controller.abort();
    releaseGate?.();

    await expect(trialPromise).rejects.toMatchObject({ type: 'aborted' });

    // A leaked trial slot would reject this with `circuit_trial_in_flight`
    // even though nothing is actually still in flight.
    await expect(
      llm.call({ systemPrompt: 's', userContent: 'after' }),
    ).resolves.not.toBeUndefined();
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

  it("getCircuitState/openCircuit/closeCircuit default an omitted model to the target's configured model, on the primary", () => {
    const { client } = createMockClient([]);

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true },
    });

    llm.openCircuit(); // no model given
    // The state must show up under the executor's configured model, the
    // same bucket real call failures would use, not an unlabeled bucket.
    expect(llm.getCircuitState({ model: 'gpt-4o' })).toBe('open');
    expect(llm.getCircuitState()).toBe('open');

    llm.closeCircuit();
    expect(llm.getCircuitState({ model: 'gpt-4o' })).toBe('closed');
  });

  it("getCircuitState/openCircuit/closeCircuit default an omitted model to the target's configured model, on a fallback", () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'gpt-4o',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true },
      fallback: {
        client: fallbackClient,
        model: 'claude-sonnet',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true },
      },
    });

    llm.openCircuit({ index: 1 }); // no model given

    expect(llm.getCircuitState({ index: 1, model: 'claude-sonnet' })).toBe('open');
    expect(llm.getCircuitState({ index: 1 })).toBe('open');
    // Primary is untouched.
    expect(llm.getCircuitState({ index: 0 })).toBe('closed');

    expect(llm.getCircuitStates()).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: true, state: 'closed' },
      {
        provider: 'fallback[0]',
        index: 1,
        isFallback: true,
        isolateByModel: true,
        state: 'open',
      },
    ]);
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
    // is for. It must never throw just because one target ignores it.
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
        // No circuit breaker on the fallback -> a real target, just untracked.
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

  it('getFailureBreakdown is undefined by default (opt-in), same as getCircuitState', () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });
    expect(llm.getFailureBreakdown()).toBeUndefined();
  });

  it('getFailureBreakdown reflects real call failures on the primary target', async () => {
    const { client } = createMockClient([new Error('down'), new Error('down')]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 5, cooldownMs: 10_000 },
    });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});
    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});

    const breakdown = llm.getFailureBreakdown();
    expect(breakdown).toBeDefined();
    const total = Object.values(breakdown ?? {}).reduce((a, b) => a + (b ?? 0), 0);
    expect(total).toBe(2);
  });

  it('getFailureBreakdown reads a fallback target by index, independent of the primary', async () => {
    const { client: primaryClient } = createMockClient([new Error('down')]);
    const { client: fallbackClient } = createMockClient([jsonResponse({ ok: true })]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      },
    });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});

    const primaryBreakdown = llm.getFailureBreakdown({ index: 0 });
    const fallbackBreakdown = llm.getFailureBreakdown({ index: 1 });
    expect(Object.keys(primaryBreakdown ?? {}).length).toBeGreaterThan(0);
    expect(fallbackBreakdown).toEqual({});
  });

  it('getFailureBreakdown throws RangeError for an out-of-range index', () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({ client, model: 'm', circuitBreaker: { threshold: 5 } });

    expect(() => llm.getFailureBreakdown({ index: 9 })).toThrow(RangeError);
  });
});
