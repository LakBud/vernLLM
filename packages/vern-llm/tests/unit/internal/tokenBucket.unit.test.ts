import { afterEach, describe, expect, it, vi } from 'vitest';

import { TokenBucket } from '../../../src/internal/tokenBucket.js';

describe('TokenBucket, tryTake', () => {
  it('takes when enough capacity is available, reducing what remains', () => {
    const bucket = new TokenBucket(10, 0);

    expect(bucket.tryTake(4)).toBe(true);
    expect(bucket.tryTake(6)).toBe(true);
  });

  it('takes exactly up to capacity, the boundary case', () => {
    const bucket = new TokenBucket(10, 0);

    expect(bucket.tryTake(10)).toBe(true);
  });

  it('fails by one unit over capacity, leaving the bucket untouched', () => {
    const bucket = new TokenBucket(10, 0);

    expect(bucket.tryTake(11)).toBe(false);
    // Untouched: a full 10 is still takeable afterward.
    expect(bucket.tryTake(10)).toBe(true);
  });

  it('fails once already at zero available', () => {
    const bucket = new TokenBucket(5, 0);

    expect(bucket.tryTake(5)).toBe(true);
    expect(bucket.tryTake(1)).toBe(false);
  });

  it('takes amount 0 unconditionally, even at zero available', () => {
    const bucket = new TokenBucket(5, 0);

    bucket.tryTake(5);

    expect(bucket.tryTake(0)).toBe(true);
  });
});

describe('TokenBucket, give', () => {
  it('returns capacity, making a later take succeed again', () => {
    const bucket = new TokenBucket(10, 0);

    bucket.tryTake(10);
    bucket.give(4);

    expect(bucket.tryTake(4)).toBe(true);
    expect(bucket.tryTake(1)).toBe(false);
  });

  it('ceilings at capacity: giving past a full bucket does not overfill it', () => {
    const bucket = new TokenBucket(10, 0);

    bucket.give(1000);

    expect(bucket.tryTake(10)).toBe(true);
    expect(bucket.tryTake(1)).toBe(false);
  });

  it('is not floored at 0: over-giving after an over-take still self-corrects toward capacity, not below it', () => {
    const bucket = new TokenBucket(10, 0);

    bucket.tryTake(10);
    // tryTake requires availability up front, so simulate an over-debit
    // (e.g. a token estimate reconciled against real usage) via give
    // with a negative amount, mirroring how the rate limiter reconciles.
    bucket.give(-5);

    expect(bucket.tryTake(1)).toBe(false);

    bucket.give(6);

    expect(bucket.tryTake(1)).toBe(true);
  });
});

describe('TokenBucket, getCapacity', () => {
  it('reports the configured capacity, unaffected by takes or gives', () => {
    const bucket = new TokenBucket(42, 0);

    bucket.tryTake(10);
    bucket.give(2);

    expect(bucket.getCapacity()).toBe(42);
  });
});

describe('TokenBucket, refill over time', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refills proportionally to elapsed time at the configured rate', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const bucket = new TokenBucket(100, 1 / 100); // 1 token per 100ms
    bucket.tryTake(100);

    vi.setSystemTime(500); // 5 refill windows -> 5 tokens back

    expect(bucket.tryTake(5)).toBe(true);
    expect(bucket.tryTake(1)).toBe(false);
  });

  it('never refills past capacity, even after a long idle period', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const bucket = new TokenBucket(10, 1); // fast refill
    bucket.tryTake(5);

    vi.setSystemTime(1_000_000);

    expect(bucket.tryTake(10)).toBe(true);
    expect(bucket.tryTake(1)).toBe(false);
  });

  it('does not shrink available capacity on a backward clock adjustment', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    const bucket = new TokenBucket(10, 1 / 1000); // 1 token per 1000ms
    bucket.tryTake(10);

    // Clock moves backward (NTP correction, VM migration, etc).
    vi.setSystemTime(5_000);

    // No time "passed" from the bucket's perspective; still empty, not
    // negative-refilled.
    expect(bucket.tryTake(1)).toBe(false);

    // Time now moves forward again from the skewed point.
    vi.setSystemTime(6_000);

    expect(bucket.tryTake(1)).toBe(true);
  });
});

describe('TokenBucket, msUntilAvailable', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 when the amount is already available', () => {
    const bucket = new TokenBucket(10, 1 / 1000);

    expect(bucket.msUntilAvailable(5)).toBe(0);
  });

  it('returns the ms until enough capacity refills, at the configured rate', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const bucket = new TokenBucket(10, 1 / 1000); // 1 token per 1000ms
    bucket.tryTake(10);

    // Needs 5 tokens back, at 1 per 1000ms -> 5000ms.
    expect(bucket.msUntilAvailable(5)).toBe(5000);
  });
});

describe('TokenBucket, concurrency mode (refillPerMs: 0)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never refills on its own from elapsed time alone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const bucket = new TokenBucket(3, 0);
    bucket.tryTake(3);

    vi.setSystemTime(1_000_000_000);

    expect(bucket.tryTake(1)).toBe(false);
  });

  it('only frees capacity via give, mirroring a released concurrency slot', () => {
    const bucket = new TokenBucket(3, 0);

    bucket.tryTake(3);
    expect(bucket.tryTake(1)).toBe(false);

    bucket.give(1);

    expect(bucket.tryTake(1)).toBe(true);
  });

  it('reports Infinity from msUntilAvailable when depleted, since only give can free it', () => {
    const bucket = new TokenBucket(3, 0);

    bucket.tryTake(3);

    expect(bucket.msUntilAvailable(1)).toBe(Infinity);
  });

  it('reports 0 from msUntilAvailable when capacity is already there', () => {
    const bucket = new TokenBucket(3, 0);

    expect(bucket.msUntilAvailable(1)).toBe(0);
  });
});
