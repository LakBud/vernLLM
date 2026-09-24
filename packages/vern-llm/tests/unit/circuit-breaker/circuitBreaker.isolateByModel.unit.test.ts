import { afterEach, describe, expect, it, vi } from 'vitest';

import { CircuitBreaker } from '../../../src/circuitBreaker.js';

// Tests switch to fake timers and spies themselves. Restoring here means a failed assertion
// can't leak them into the next test.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it('recordSuccess is a no-op when no bucket exists yet for the model (isolateByModel)', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, isolateByModel: true });

    // isolateByModel allocates a bucket per model lazily via
    // ensureBucketFor; recordSuccess only *looks up* a bucket, so a model
    // that's never been through assertClosed/recordFailure has none yet.
    expect(() => cb.recordSuccess('never-seen-model')).not.toThrow();
    expect(cb.getState('never-seen-model')).toBe('closed');
  });

  it('evicts a model bucket once it returns to a pristine closed state', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, isolateByModel: true });
    const buckets = (cb as unknown as { bucketsByModel: Map<string, unknown> }).bucketsByModel;

    cb.recordFailure('gpt-4o');
    expect(buckets.size).toBe(1);

    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    cb.assertClosed('gpt-4o');
    cb.recordSuccess('gpt-4o');
    vi.useRealTimers();

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
  });
});
