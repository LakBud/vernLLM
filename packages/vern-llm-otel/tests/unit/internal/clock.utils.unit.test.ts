import { describe, expect, it } from 'vitest';

import { elapsedMs, nowMs } from '../../../src/internal/clock.utils.js';

describe('clock helpers', () => {
  it('nowMs is monotonic and finite', () => {
    const a = nowMs();
    const b = nowMs();

    expect(Number.isFinite(a)).toBe(true);
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it('subtracts the wait from the elapsed time', () => {
    expect(elapsedMs(100, 30, 200)).toBe(70);
    expect(elapsedMs(100, 0, 200)).toBe(100);
    expect(elapsedMs(100, undefined, 200)).toBe(100);
  });

  it('clamps at zero when the wait exceeds the elapsed time or the clock goes backwards', () => {
    expect(elapsedMs(100, 500, 200)).toBe(0);
    expect(elapsedMs(200, 0, 100)).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -50])(
    'ignores an unusable wait (%s)',
    (waited) => {
      expect(elapsedMs(100, waited, 200)).toBe(100);
    },
  );

  it.each([
    [Number.NaN, 200],
    [100, Number.NaN],
    [Number.POSITIVE_INFINITY, 200],
    [100, Number.POSITIVE_INFINITY],
  ])('returns zero for a non finite endpoint (%s, %s)', (start, end) => {
    expect(elapsedMs(start, 0, end)).toBe(0);
  });

  it('reads the clock itself when no end is given', () => {
    expect(elapsedMs(nowMs() - 5)).toBeGreaterThanOrEqual(5);
  });
});
