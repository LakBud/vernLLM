import { afterEach, describe, expect, it, vi } from 'vitest';

import { CircuitBreaker, type CircuitBreakerCallContext } from '../../src/circuitBreaker.js';
import { createMiddlewareStateBag } from '../../src/types/index.js';

function ctx(): CircuitBreakerCallContext {
  return { requestId: 'r', state: createMiddlewareStateBag() };
}

function openThenCooldown(options: ConstructorParameters<typeof CircuitBreaker>[0] = {}) {
  const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, ...options });
  cb.recordFailure();
  vi.advanceTimersByTime(1001);
  return cb;
}

describe('CircuitBreaker.releaseTrial', () => {
  afterEach(() => vi.useRealTimers());

  it('gives back the only trial slot so the next call can claim it', () => {
    vi.useFakeTimers();
    const cb = openThenCooldown();
    const first = ctx();

    cb.assertClosed(undefined, first);
    expect(() => cb.assertClosed(undefined, ctx())).toThrowError(/half-open/i);

    cb.releaseTrial(undefined, first);

    expect(cb.getState()).toBe('half-open');
    expect(() => cb.assertClosed(undefined, ctx())).not.toThrow();
  });

  it('is idempotent: a second release does not mint an extra slot', () => {
    vi.useFakeTimers();
    const cb = openThenCooldown();
    const first = ctx();

    cb.assertClosed(undefined, first);
    cb.releaseTrial(undefined, first);
    cb.releaseTrial(undefined, first);

    expect(() => cb.assertClosed(undefined, ctx())).not.toThrow();
    expect(() => cb.assertClosed(undefined, ctx())).toThrowError(/half-open/i);
  });

  it('is a no-op after an outcome was recorded for that call', () => {
    vi.useFakeTimers();
    const cb = openThenCooldown({ halfOpenProbes: 2 });
    const first = ctx();
    const second = ctx();

    cb.assertClosed(undefined, first);
    cb.assertClosed(undefined, second);
    cb.recordFailure(undefined, first);

    // first's permit is spent, so releasing it must not free a slot.
    cb.releaseTrial(undefined, first);

    expect(() => cb.assertClosed(undefined, ctx())).toThrowError(/half-open/i);
  });

  it('a call that never claimed a trial cannot release someone else', () => {
    vi.useFakeTimers();
    const cb = openThenCooldown();
    const holder = ctx();

    cb.assertClosed(undefined, holder);
    cb.releaseTrial(undefined, ctx());

    expect(() => cb.assertClosed(undefined, ctx())).toThrowError(/half-open/i);
  });

  it('is a no-op without a context, when closed, and when open', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });

    expect(() => cb.releaseTrial(undefined, ctx())).not.toThrow();
    cb.recordFailure();
    expect(() => cb.releaseTrial(undefined, ctx())).not.toThrow();
    expect(() => cb.releaseTrial()).not.toThrow();
    expect(cb.getState()).toBe('open');
  });

  it('a stale permit from a previous trial cannot release the current one', () => {
    vi.useFakeTimers();
    const cb = openThenCooldown();
    const oldHolder = ctx();

    cb.assertClosed(undefined, oldHolder);
    cb.recordFailure(undefined, oldHolder); // trial failed, reopens
    vi.advanceTimersByTime(1001);

    const newHolder = ctx();
    cb.assertClosed(undefined, newHolder);
    cb.releaseTrial(undefined, oldHolder);

    expect(() => cb.assertClosed(undefined, ctx())).toThrowError(/half-open/i);
  });

  it('respects isolateByModel', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, isolateByModel: true });
    cb.recordFailure('a');
    vi.advanceTimersByTime(1001);
    const holder = ctx();
    cb.assertClosed('a', holder);

    cb.releaseTrial('b', holder);
    expect(() => cb.assertClosed('a', ctx())).toThrowError(/half-open/i);

    cb.releaseTrial('a', holder);
    expect(() => cb.assertClosed('a', ctx())).not.toThrow();
  });
});
