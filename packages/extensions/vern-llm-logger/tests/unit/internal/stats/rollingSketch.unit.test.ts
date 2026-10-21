import { describe, expect, it } from 'vitest';

import { RollingSketch } from '../../../../src/internal/stats/rollingSketch.js';

// A window of 6,000 ms in six slots of 1,000 ms. `now` is passed in, so no timers are needed.
const make = (cachedQuantile?: number) => new RollingSketch(6000, 6, cachedQuantile);

describe('RollingSketch', () => {
  it('is empty before anything is added', () => {
    const rolling = make();

    expect(rolling.count(0)).toBe(0);
    expect(rolling.quantiles(0, [0.5])).toEqual([undefined]);
  });

  it('reports values across slots until they leave the window', () => {
    const rolling = make();
    rolling.add(0, 100);
    rolling.add(3000, 200);

    expect(rolling.count(3000)).toBe(2);
    // Slot of t=0 is the oldest still live at t=5999, and gone at t=6000.
    expect(rolling.count(5999)).toBe(2);
    expect(rolling.count(6000)).toBe(1);
    expect(rolling.count(9000)).toBe(0);
  });

  it('clears a slot that still holds an older period when it is reused', () => {
    const rolling = make();
    rolling.add(0, 100);
    // Same slot index, one full window later: the old value must not leak in.
    rolling.add(6000, 7);

    expect(rolling.count(6000)).toBe(1);
    expect(rolling.quantiles(6000, [1])[0]).toBeCloseTo(7, 5);
  });

  it('forgets everything after an idle gap longer than the window', () => {
    const rolling = make();
    for (let t = 0; t < 6000; t += 500) rolling.add(t, 50);

    expect(rolling.count(1_000_000)).toBe(0);
    rolling.add(1_000_000, 9);
    expect(rolling.count(1_000_000)).toBe(1);
  });

  it('tracks the tag of the largest value still in the window', () => {
    const rolling = make();
    rolling.add(0, 900, 'slow-old');
    rolling.add(3000, 300, 'mid');
    rolling.add(3500, 100, 'fast');

    expect(rolling.slowest(3500)?.tag).toBe('slow-old');
    expect(rolling.slowest(3500)?.value).toBeCloseTo(900, -1);
    expect(rolling.slowest(6000)?.tag).toBe('mid');
    expect(rolling.slowest(20_000)).toBeUndefined();
  });

  it('recomputes the cached quantile once per slot period, not once per read', () => {
    const rolling = make(0.5);
    for (let i = 0; i < 30; i++) rolling.add(100, 100);
    const first = rolling.cachedQuantile(100);
    expect(first).toBeCloseTo(100, 0);

    // More data in the same period does not change the cached figure until the period turns.
    for (let i = 0; i < 300; i++) rolling.add(200, 1000);
    expect(rolling.cachedQuantile(200)).toBe(first);

    expect(rolling.cachedQuantile(1100)).toBeGreaterThan(500);
  });

  it('has no cached quantile when none is configured', () => {
    const rolling = make();
    rolling.add(0, 5);

    expect(rolling.cachedQuantile(0)).toBeUndefined();
  });

  it('clears all state', () => {
    const rolling = make(0.5);
    rolling.add(0, 5, 'x');
    rolling.clear();

    expect(rolling.count(0)).toBe(0);
    expect(rolling.slowest(0)).toBeUndefined();
  });
});
