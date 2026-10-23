import { describe, expect, it } from 'vitest';

import { overLimits } from '../../../src/internal/decide/limits.utils.js';

import type { Signals } from '../../../src/internal/decide/signals.js';

const base = { limited: false, warmingFactor: 1, inFlight: 0 };
const signals = (values: Record<string, Partial<Signals>>) =>
  new Map(Object.entries(values).map(([name, value]) => [name, { ...base, ...value }]));
const limits = { latencyMs: 1000, costUsd: 0.5, qualityFailureRate: 0.2 };

describe('overLimits', () => {
  it('flags a target over any limit, and never an unknown value', () => {
    const over = overLimits(
      ['a', 'b', 'c', 'd', 'e'],
      signals({
        a: { latencyMs: 1001 },
        b: { costUsd: 0.51 },
        c: { qualityFailureRate: 0.21 },
        d: { latencyMs: 1000, costUsd: 0.5, qualityFailureRate: 0.2 },
        e: {},
      }),
      limits,
      0,
      undefined,
    );
    expect([...over]).toEqual([
      ['a', 'over_limit'],
      ['b', 'over_limit'],
      ['c', 'over_limit'],
    ]);
  });

  it('flags a target whose estimate is above the time left, predicted before plain', () => {
    const over = overLimits(
      ['a', 'b', 'c', 'd'],
      signals({
        a: { latencyMs: 100, predictedLatencyMs: 3500 },
        b: { latencyMs: 3500 },
        c: { latencyMs: 4000, predictedLatencyMs: 900 },
        d: {},
      }),
      undefined,
      1000,
      3000,
    );
    expect([...over]).toEqual([
      ['a', 'over_deadline'],
      ['b', 'over_deadline'],
    ]);
  });

  it('prefers over_limit when both apply, and ignores a deadline when none is set', () => {
    const both = overLimits(['a'], signals({ a: { latencyMs: 9000 } }), limits, 0, 100);
    expect(both.get('a')).toBe('over_limit');
    expect(
      overLimits(['a'], signals({ a: { latencyMs: 9000 } }), undefined, 0, undefined).size,
    ).toBe(0);
  });
});
