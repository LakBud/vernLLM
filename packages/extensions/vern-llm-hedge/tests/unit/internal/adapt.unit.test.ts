import { describe, expect, it } from 'vitest';

import { Adapt } from '../../../src/internal/adapt.js';
import { normalizeOptions } from '../../../src/internal/options/normalizeOptions.utils.js';

const stats = { quantile: () => 100 };

function adaptOf(base: number | undefined, adapt: Record<string, number> = {}) {
  const config = normalizeOptions({
    stats,
    adapt: { window: 4, minHedges: 4, lowWinRate: 0.25, highWinRate: 0.5, ...adapt },
  }).adapt!;
  return new Adapt(config, base);
}

/** Records hedged calls one at a time for `target`, returning the last change they caused. */
function record(adapt: Adapt, results: boolean[], now = 0, target = 'a') {
  return results
    .map((won) => adapt.record(target, won, now))
    .filter(Boolean)
    .at(-1);
}

describe('a target whose hedges rarely win', () => {
  it('waits for a higher quantile, a step at a time, and then stops being hedged', () => {
    const adapt = adaptOf(0.95);
    const lost = [false, false, false, false];

    expect(adapt.quantileFor('a', 0.95)).toBe(0.95);
    expect(record(adapt, lost)).toMatchObject({ action: 'raise_quantile', winRate: 0, hedges: 4 });
    expect(adapt.quantileFor('a', 0.95)).toBeCloseTo(0.97);
    expect(record(adapt, lost)).toMatchObject({ action: 'raise_quantile' });
    expect(adapt.quantileFor('a', 0.95)).toBeCloseTo(0.99);

    // Already at the ceiling: nothing left to raise.
    expect(record(adapt, lost, 1_000)).toMatchObject({ action: 'pause' });
    expect(adapt.paused('a', 1_000)).toBe(true);
    expect(adapt.paused('a', 1_000 + 300_000)).toBe(false);
    // Starting over after the pause, at the configured quantile.
    expect(adapt.quantileFor('a', 0.95)).toBe(0.95);
  });

  it('starts judging again from nothing after a change', () => {
    const adapt = adaptOf(0.95);

    record(adapt, [false, false, false, false]);

    expect(adapt.record('a', false, 0)).toBeUndefined();
  });

  it('pauses at once when the delay has no quantile to raise', () => {
    const adapt = adaptOf(undefined, { pauseMs: 50 });

    expect(record(adapt, [false, false, false, false], 10)).toMatchObject({ action: 'pause' });
    expect(adapt.paused('a', 59)).toBe(true);
    expect(adapt.paused('a', 60)).toBe(false);
  });

  it('pauses at once when the configured quantile is already above the ceiling', () => {
    const adapt = adaptOf(0.995);

    expect(record(adapt, [false, false, false, false])).toMatchObject({ action: 'pause' });
  });

  it('never raises another target`s quantile', () => {
    const adapt = adaptOf(0.95);
    record(adapt, [false, false, false, false]);

    expect(adapt.quantileFor('b', 0.95)).toBe(0.95);
    expect(adapt.paused('b', 0)).toBe(false);
  });
});

describe('a target whose hedges often win', () => {
  it('is reported once as slow, until the rate falls back', () => {
    const adapt = adaptOf(0.95);

    expect(record(adapt, [true, true, true, true])).toMatchObject({
      action: 'slow',
      winRate: 1,
      hedges: 4,
    });
    expect(adapt.record('a', true, 0)).toBeUndefined();

    // Back to a middling rate, which is neither low nor high, then high again.
    record(adapt, [false, true, false, true]);
    expect(record(adapt, [true, true, true, true])).toMatchObject({ action: 'slow' });
  });

  it('is reported again every `minHedges` hedged calls while the rate stays high', () => {
    const adapt = adaptOf(0.95);
    const wins = (count: number) =>
      Array.from({ length: count }, () => adapt.record('a', true, 0)?.action);

    expect(wins(4)).toEqual([undefined, undefined, undefined, 'slow']);
    expect(wins(8)).toEqual([
      undefined,
      undefined,
      undefined,
      'slow',
      undefined,
      undefined,
      undefined,
      'slow',
    ]);
  });

  it('judges only the latest window of hedged calls', () => {
    const adapt = adaptOf(0.95);

    record(adapt, [true, true, true, true]);
    const change = record(adapt, [false, true, false, true]);

    expect(change).toBeUndefined();
  });
});

describe('before there is enough to judge by', () => {
  it('changes nothing', () => {
    const adapt = adaptOf(0.95);

    expect(record(adapt, [false, false, false])).toBeUndefined();
    expect(adapt.quantileFor('a', 0.95)).toBe(0.95);
  });
});
