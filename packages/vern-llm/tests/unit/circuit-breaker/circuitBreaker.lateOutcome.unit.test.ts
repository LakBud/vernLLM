import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CircuitBreaker } from '../../../src/circuitBreaker.js';

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
