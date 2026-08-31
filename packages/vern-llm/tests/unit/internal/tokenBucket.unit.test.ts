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

describe('TokenBucket, resize', () => {
  it('grows capacity and getCapacity() reflects the new ceiling', () => {
    const bucket = new TokenBucket(100, 100 / 60_000);

    bucket.resize(150);

    expect(bucket.getCapacity()).toBe(150);
  });

  it('shrinking clamps available down to the new capacity', () => {
    const bucket = new TokenBucket(100, 0);

    // Full at 100, shrink to 40: available must clamp down, not stay at 100.
    bucket.resize(40);

    expect(bucket.tryTake(40)).toBe(true);
    expect(bucket.tryTake(1)).toBe(false);
  });

  it('growing never raises available beyond what was actually there', () => {
    const bucket = new TokenBucket(100, 0);

    bucket.tryTake(90); // available: 10
    bucket.resize(200); // capacity grows, available should still be 10, not 200

    expect(bucket.tryTake(10)).toBe(true);
    expect(bucket.tryTake(1)).toBe(false);
  });

  it('rescales refillPerMs proportionally to the capacity change, not left at the old rate', () => {
    // capacity 600, refillPerMs = 600/60_000 = 0.01/ms -> full refill in 60s
    const bucket = new TokenBucket(600, 600 / 60_000);

    bucket.tryTake(600); // available: 0
    bucket.resize(60); // shrink to 1/10th; refillPerMs should also shrink 1/10th

    // At the old (unscaled) refillPerMs, 60 units would refill in 6s.
    // At the correctly rescaled refillPerMs (60/60_000 = 0.001/ms), a
    // full refill of the new, smaller capacity still takes 60s.
    expect(bucket.msUntilAvailable(60)).toBeCloseTo(60_000, -2);
  });

  it('is idempotent under repeated shrink/grow, each resize building on the last, not the original construction values', () => {
    const bucket = new TokenBucket(1000, 1000 / 60_000);

    bucket.resize(500); // refillPerMs: 500/60_000; available clamps 1000 -> 500
    bucket.resize(250); // refillPerMs: 250/60_000, derived from 500's rate, not 1000's; available clamps 500 -> 250
    bucket.resize(1000); // refillPerMs: 1000/60_000 again; available is NOT raised back to 1000 (a grow never manufactures capacity that wasn't there), it stays at 250

    // refillPerMs ended up back at the original 1000/60_000 rate, the
    // three resizes composed correctly rather than drifting. Confirmed
    // by the time to go from the known available (250, per the clamp
    // history above) up to the full 1000 capacity: at 1000/60_000 per
    // ms, refilling the missing 750 takes exactly 45s, not some drifted
    // rate.
    expect(bucket.msUntilAvailable(1000)).toBeCloseTo(45_000, -2);
  });

  it('a concurrency bucket (refillPerMs === 0) is unaffected by rescaling, stays 0 after resize', () => {
    const bucket = new TokenBucket(10, 0);

    bucket.resize(5);

    // If refillPerMs were left at some nonzero derived value, this
    // bucket would start refilling on a clock, which a concurrency
    // bucket must never do; msUntilAvailable staying Infinity once
    // depleted proves refillPerMs is still exactly 0.
    bucket.tryTake(5);
    expect(bucket.msUntilAvailable(1)).toBe(Infinity);
  });
});
