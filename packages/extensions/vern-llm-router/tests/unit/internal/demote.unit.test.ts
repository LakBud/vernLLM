import { describe, expect, it } from 'vitest';

import { demote } from '../../../src/internal/decide/demote.utils.js';

import type { Signals } from '../../../src/internal/decide/signals.js';

const sig = (over: Partial<Signals> = {}): Signals => ({
  limited: false,
  warmingFactor: 1,
  inFlight: 0,
  ...over,
});
const run = (
  order: string[],
  signals: Record<string, Partial<Signals>>,
  extra: {
    health?: boolean;
    rng?: () => number;
    over?: Record<string, 'over_limit' | 'over_deadline'>;
  } = {},
) =>
  demote({
    order,
    over: new Map(Object.entries(extra.over ?? {})),
    signals: new Map(Object.entries(signals).map(([name, value]) => [name, sig(value)])),
    health: extra.health ?? true,
    rng: extra.rng ?? (() => 0),
  });

describe('demote over limits and deadlines', () => {
  it('puts targets over a limit or past the deadline behind healthy, ahead of limited and open', () => {
    const result = run(
      ['a', 'b', 'd', 'e', 'c'],
      { a: { circuit: 'open' }, b: { limited: true } },
      { over: { d: 'over_limit', e: 'over_deadline' } },
    );
    expect(result.order).toEqual(['c', 'd', 'e', 'b', 'a']);
    expect(result.demoted).toEqual([
      { target: 'd', reason: 'over_limit' },
      { target: 'e', reason: 'over_deadline' },
      { target: 'b', reason: 'limited' },
      { target: 'a', reason: 'open' },
    ]);
  });

  it('leaves the order unchanged when every target is over', () => {
    const result = run(['a', 'b'], {}, { over: { a: 'over_deadline', b: 'over_deadline' } });
    expect(result).toEqual({ order: ['a', 'b'], demoted: [] });
  });

  it('applies soft limits even with health off, but not open or limited', () => {
    const result = run(
      ['a', 'b', 'c'],
      { a: { circuit: 'open' }, b: {} },
      { health: false, over: { a: 'over_limit' } },
    );
    expect(result.order).toEqual(['b', 'c', 'a']);
    expect(result.demoted).toEqual([{ target: 'a', reason: 'over_limit' }]);
  });

  it('counts a target both limited and over as limited', () => {
    const result = run(['a', 'b'], { a: { limited: true } }, { over: { a: 'over_limit' } });
    expect(result.demoted).toEqual([{ target: 'a', reason: 'limited' }]);
  });
});

describe('demote', () => {
  it('orders healthy, limited, open and keeps each group in its incoming order', () => {
    const result = run(['a', 'b', 'c', 'd', 'e'], {
      a: { circuit: 'open' },
      b: { limited: true },
      c: {},
      d: { circuit: 'open' },
      e: { limited: true },
    });
    expect(result.order).toEqual(['c', 'b', 'e', 'a', 'd']);
    // Only the targets the healthy one overtook; e and d were already behind it.
    expect(result.demoted).toEqual([
      { target: 'b', reason: 'limited' },
      { target: 'a', reason: 'open' },
    ]);
  });

  it('counts an open and limited target as open', () => {
    expect(
      run(['a', 'b', 'c'], { a: { circuit: 'open', limited: true }, b: { limited: true } }).order,
    ).toEqual(['c', 'b', 'a']);
  });

  it('does not report a target that was already last', () => {
    const result = run(['a', 'b'], { b: { circuit: 'open' } });
    expect(result).toEqual({ order: ['a', 'b'], demoted: [] });
  });

  it('keeps half open and closed targets in place', () => {
    const result = run(['a', 'b'], { a: { circuit: 'half-open' }, b: { circuit: 'closed' } });
    expect(result).toEqual({ order: ['a', 'b'], demoted: [] });
  });

  it('leaves the order unchanged when nothing is healthy', () => {
    const result = run(['a', 'b'], { a: { circuit: 'open' }, b: { limited: true } });
    expect(result).toEqual({ order: ['a', 'b'], demoted: [] });
  });

  it('skips the limited and open groups with health off', () => {
    const result = run(['a', 'b'], { a: { circuit: 'open' } }, { health: false });
    expect(result).toEqual({ order: ['a', 'b'], demoted: [] });
  });

  it('lets a warming first target give way to the next healthy one by chance', () => {
    const signals = { a: { warmingFactor: 0.25 }, b: { circuit: 'open' as const }, c: {} };

    const gives = run(['a', 'b', 'c'], signals, { rng: () => 0.74 });
    expect(gives.order).toEqual(['c', 'a', 'b']);
    expect(gives.demoted).toContainEqual({ target: 'a', reason: 'warming' });

    // rng < 1 - factor = 0.75 gives way; at or above it, the target takes the call.
    expect(run(['a', 'b', 'c'], signals, { rng: () => 0.75 }).demoted).not.toContainEqual({
      target: 'a',
      reason: 'warming',
    });
  });

  it('does not draw when there is nobody healthy to give way to', () => {
    let draws = 0;
    const result = run(
      ['a', 'b'],
      { a: { warmingFactor: 0.1 }, b: { circuit: 'open' } },
      {
        rng: () => (draws++, 0),
      },
    );
    expect(result.order).toEqual(['a', 'b']);
    expect(draws).toBe(0);
  });

  it('does not draw for a target that is not warming', () => {
    let draws = 0;
    run(['a', 'b'], {}, { rng: () => (draws++, 0) });
    expect(draws).toBe(0);
  });

  it('handles an empty order', () => {
    expect(run([], {})).toEqual({ order: [], demoted: [] });
  });

  it('assumes a target without signals is healthy', () => {
    const result = demote({ order: ['a', 'b'], signals: new Map(), health: true, rng: () => 0 });
    expect(result.order).toEqual(['a', 'b']);
  });
});
