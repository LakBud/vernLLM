import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RollingRatio } from '../../../src/internal/rollingRatio.js';

describe('RollingRatio (unit)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws for a non positive windowMs', () => {
    expect(() => new RollingRatio(0)).toThrow(RangeError);
    expect(() => new RollingRatio(-1)).toThrow(RangeError);
  });

  it('throws for a non finite windowMs', () => {
    expect(() => new RollingRatio(Infinity)).toThrow(RangeError);
    expect(() => new RollingRatio(NaN)).toThrow(RangeError);
  });

  it('reports 0 ratio and 0 count before anything is recorded', () => {
    const ratio = new RollingRatio(60_000);
    expect(ratio.getRatio()).toBe(0);
    expect(ratio.getCount()).toBe(0);
  });

  it('computes the ratio correctly across recorded outcomes', () => {
    const ratio = new RollingRatio(60_000);
    ratio.record(true);
    ratio.record(true);
    ratio.record(false);
    ratio.record(false);

    expect(ratio.getCount()).toBe(4);
    expect(ratio.getRatio()).toBe(0.5);
  });

  it('rolls entries off once they age past the window', () => {
    const ratio = new RollingRatio(10_000);

    for (let i = 0; i < 10; i++) ratio.record(true);
    expect(ratio.getCount()).toBe(10);
    expect(ratio.getRatio()).toBe(1);

    // Advancing past the full window rolls every old entry off.
    vi.advanceTimersByTime(10_000);
    expect(ratio.getCount()).toBe(0);
    expect(ratio.getRatio()).toBe(0);
  });

  it('entries recorded well within the window stay counted, older ones age out on their own', () => {
    const ratio = new RollingRatio(10_000);

    ratio.record(true); // recorded at t=0
    vi.advanceTimersByTime(9_000); // still within the 10s window
    ratio.record(false); // recorded at t=9000

    expect(ratio.getCount()).toBe(2);

    vi.advanceTimersByTime(2_000); // t=0 entry is now outside the window
    expect(ratio.getCount()).toBe(1);
    expect(ratio.getRatio()).toBe(0); // only the t=9000 success remains
  });

  it('recovers correctly after an idle gap well beyond windowMs', () => {
    const ratio = new RollingRatio(10_000);

    ratio.record(true);
    expect(ratio.getCount()).toBe(1);

    // Idle for far longer than the window before the next outcome.
    vi.advanceTimersByTime(100_000);
    ratio.record(false);

    expect(ratio.getCount()).toBe(1);
  });

  it('getCount and getRatio agree after a reset', () => {
    const ratio = new RollingRatio(60_000);
    ratio.record(true);
    ratio.record(true);
    ratio.record(false);

    ratio.reset();

    expect(ratio.getCount()).toBe(0);
    expect(ratio.getRatio()).toBe(0);

    ratio.record(false);
    expect(ratio.getCount()).toBe(1);
    expect(ratio.getRatio()).toBe(0);
  });
});
