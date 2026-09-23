import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CircuitBreaker, type CircuitBreakerCallContext } from '../../../src/circuitBreaker.js';
import { createMiddlewareStateBag } from '../../../src/types/index.js';

function ctx(requestId: string): CircuitBreakerCallContext {
  return { requestId, state: createMiddlewareStateBag() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CircuitBreaker, late outcomes while open (unit)', () => {
  it('a late success from a call admitted before the trip does not close the circuit', () => {
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, onStateChange });

    cb.recordFailure();
    expect(cb.getState()).toBe('open');

    cb.recordSuccess();

    expect(cb.getState()).toBe('open');
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    expect(onStateChange).toHaveBeenCalledTimes(1);
  });

  it('a late success does not close a per model circuit or evict its bucket', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, isolateByModel: true });
    const buckets = (cb as unknown as { bucketsByModel: Map<string, unknown> }).bucketsByModel;

    cb.recordFailure('gpt-4o');
    cb.recordSuccess('gpt-4o');

    expect(cb.getState('gpt-4o')).toBe('open');
    expect(buckets.size).toBe(1);
  });

  it('late failures while open do not extend the cooldown', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });

    cb.recordFailure();
    vi.advanceTimersByTime(900);
    cb.recordFailure();
    cb.recordFailure();
    vi.advanceTimersByTime(100);

    expect(() => cb.assertClosed()).not.toThrow();
    expect(cb.getState()).toBe('half-open');
  });

  it('late failures while open do not feed the tripping policy or the breakdown', () => {
    const cb = new CircuitBreaker({
      cooldownMs: 1000,
      tripping: { kind: 'rolling', windowMs: 10_000, minCalls: 1, failureRatio: 0.5 },
    });

    cb.recordFailure(undefined, undefined, 'server_error');
    cb.recordFailure(undefined, undefined, 'server_error');

    expect(cb.getFailureBreakdown()).toEqual({ server_error: 1 });
  });

  it('a late failure does not reopen with a fresh openedAt, so onStateChange stays quiet', () => {
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, onStateChange });

    cb.recordFailure();
    cb.recordFailure();

    expect(onStateChange).toHaveBeenCalledTimes(1);
  });
});

describe('CircuitBreaker.getState after cooldown (unit)', () => {
  it('reports half-open once the cooldown has elapsed, without transitioning', () => {
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, onStateChange });

    cb.recordFailure();
    vi.advanceTimersByTime(999);
    expect(cb.getState()).toBe('open');

    vi.advanceTimersByTime(1);
    expect(cb.getState()).toBe('half-open');
    // Read only: the real transition waits for the next call.
    expect(onStateChange).toHaveBeenCalledTimes(1);
  });

  it('reports open again after a failed trial restarts the cooldown', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });

    cb.recordFailure();
    vi.advanceTimersByTime(1000);
    cb.assertClosed();
    cb.recordFailure();

    expect(cb.getState()).toBe('open');
  });

  it('reports per model state independently under isolateByModel', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, isolateByModel: true });

    cb.recordFailure('a');
    vi.advanceTimersByTime(500);
    cb.recordFailure('b');
    vi.advanceTimersByTime(500);

    expect(cb.getState('a')).toBe('half-open');
    expect(cb.getState('b')).toBe('open');
    expect(cb.getState('c')).toBe('closed');
  });
});

describe('CircuitBreaker, outcomes from an earlier generation (unit)', () => {
  function recoveredBreaker() {
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000, onStateChange });

    // Admitted while closed, settles only after recovery.
    const straggler = ctx('straggler');
    cb.assertClosed(undefined, straggler);

    const tripper = ctx('tripper');
    cb.assertClosed(undefined, tripper);
    cb.recordFailure(undefined, tripper, 'server_error');
    cb.recordFailure(undefined, ctx('other'), 'server_error');
    expect(cb.getState()).toBe('open');

    vi.advanceTimersByTime(1000);
    const probe = ctx('probe');
    cb.assertClosed(undefined, probe);
    cb.recordSuccess(undefined, probe);
    expect(cb.getState()).toBe('closed');
    onStateChange.mockClear();

    return { cb, straggler, onStateChange };
  }

  it('a late failure cannot count against the recovered generation', () => {
    const { cb, straggler, onStateChange } = recoveredBreaker();

    cb.recordFailure(undefined, straggler, 'request_timeout');

    expect(cb.getFailureBreakdown()).toEqual({});
    // One fresh failure alone must not trip a threshold of 2.
    const fresh = ctx('fresh');
    cb.assertClosed(undefined, fresh);
    cb.recordFailure(undefined, fresh, 'server_error');
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailureBreakdown()).toEqual({ server_error: 1 });
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('a late success cannot reset the recovered generation', () => {
    const { cb, straggler } = recoveredBreaker();

    const fresh = ctx('fresh');
    cb.assertClosed(undefined, fresh);
    cb.recordFailure(undefined, fresh, 'server_error');

    cb.recordSuccess(undefined, straggler);

    // The fresh failure still stands, so one more trips a threshold of 2.
    const next = ctx('next');
    cb.assertClosed(undefined, next);
    cb.recordFailure(undefined, next, 'server_error');
    expect(cb.getState()).toBe('open');
  });
});

describe('CircuitBreaker, shrinking cooldownBackoff (unit)', () => {
  it('a multiplier below 1 never takes a repeat cooldown under cooldownMs', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const cb = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      cooldownBackoff: { multiplier: 0.5 },
    });

    cb.recordFailure();
    vi.advanceTimersByTime(1000);
    cb.assertClosed();

    // Trial fails: reopenCount 1, exp 500, but the floor stays 1000.
    cb.recordFailure();
    vi.advanceTimersByTime(999);
    expect(() => cb.assertClosed()).toThrow(
      expect.objectContaining({ code: 'circuit_cooling_down' }),
    );
    vi.advanceTimersByTime(1);
    expect(() => cb.assertClosed()).not.toThrow();

    randomSpy.mockRestore();
  });
});

describe('CircuitBreaker, outcomes from a call this breaker never admitted (unit)', () => {
  it('cannot settle a half-open trial it holds no permit for', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });

    cb.recordFailure();
    vi.advanceTimersByTime(1000);
    cb.assertClosed(undefined, ctx('probe'));
    expect(cb.getState()).toBe('half-open');

    cb.recordSuccess(undefined, ctx('stranger'));
    cb.recordFailure(undefined, ctx('stranger'));

    expect(cb.getState()).toBe('half-open');
  });
});
