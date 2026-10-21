import { describe, expect, it } from 'vitest';

import { elapsedMs, nowMs } from '../../../src/internal/clock.utils.js';

describe('clock helpers', () => {
  it('nowMs is monotonic and finite', () => {
    const a = nowMs();
    const b = nowMs();

    expect(Number.isFinite(a)).toBe(true);
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it('measures from start to end', () => {
    expect(elapsedMs(100, 200)).toBe(100);
  });

  it('clamps at zero when the clock goes backwards', () => {
    expect(elapsedMs(200, 100)).toBe(0);
  });

  it.each([
    [Number.NaN, 200],
    [100, Number.NaN],
    [Number.POSITIVE_INFINITY, 200],
    [100, Number.POSITIVE_INFINITY],
  ])('returns zero for a non finite endpoint (%s, %s)', (start, end) => {
    expect(elapsedMs(start, end)).toBe(0);
  });

  it('reads the clock itself when no end is given', () => {
    expect(elapsedMs(nowMs() - 5)).toBeGreaterThanOrEqual(5);
  });
});
