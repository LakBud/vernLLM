import { afterEach, describe, expect, it, vi } from 'vitest';

import { CircuitBreaker } from '../../../src/circuitBreaker.js';
import { createMiddlewareStateBag } from '../../../src/types/index.js';

// Tests switch to fake timers and spies themselves. Restoring here means a failed assertion
// can't leak them into the next test.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
  });

  it('getFailureBreakdown returns a plain object copy, not a live reference', () => {
    const cb = new CircuitBreaker({ threshold: 10 });

    cb.recordFailure(undefined, undefined, 'server_error');
    const breakdown = cb.getFailureBreakdown();
    breakdown.server_error = 999;

    expect(cb.getFailureBreakdown()).toEqual({ server_error: 1 });
  });
});
