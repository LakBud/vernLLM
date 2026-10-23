import { describe, expect, it } from 'vitest';

import { decide } from '../../../src/internal/decide/decide.js';
import { hash32, hashUnit } from '../../../src/internal/hash.utils.js';
import { normalizeOptions } from '../../../src/internal/options/normalizeOptions.utils.js';
import { seededRng } from './seededRng.js';

import type { RouterOptions } from '../../../src/index.js';
import type { RequestFacts } from '../../../src/internal/match/requestFacts.utils.js';

const facts: RequestFacts = {
  hasTools: false,
  jsonOutput: false,
  jsonSchema: false,
  images: false,
  maxTokens: 10,
  inputTokens: 10,
};

function run(
  routeOptions: NonNullable<RouterOptions['routes']>[number],
  extra: { rng?: () => number; stickyUnit?: number; targets?: string[] } = {},
) {
  return decide({
    targets: extra.targets ?? ['a', 'b', 'c'],
    route: normalizeOptions({ routes: [routeOptions] }).routes[0],
    capabilities: new Map(),
    facts,
    rng: extra.rng ?? (() => 0),
    stickyUnit: extra.stickyUnit,
  });
}

const weighted = (weights: Record<string, number>, stickyBy?: string) => ({
  name: 'w',
  strategy: { type: 'weighted' as const, weights, ...(stickyBy ? { stickyBy } : {}) },
});

describe('weighted', () => {
  it('picks the last target when rounding leaves a draw past every weight', () => {
    // A draw just under 1, less 0.3, rounds to exactly 0.7, which is not below the weight 0.7.
    const route = weighted({ a: 0.3, b: 0.7 });
    const result = run(route, { rng: () => 0.9999999999999999, targets: ['a', 'b'] });
    expect(result.order).toEqual(['b', 'a']);
  });

  it('picks by the draw, and the rest follow by weight with declared order as the tie break', () => {
    const route = weighted({ a: 1, b: 6, c: 3 });
    // cumulative: a [0,0.1) c? no: declared order a, b, c with 1, 6, 3 of 10.
    expect(run(route, { rng: () => 0.05 }).order).toEqual(['a', 'b', 'c']);
    expect(run(route, { rng: () => 0.5 }).order).toEqual(['b', 'c', 'a']);
    expect(run(route, { rng: () => 0.95 }).order).toEqual(['c', 'b', 'a']);
    expect(run(route, { rng: () => 0.5 }).strategy).toBe('weighted');
  });

  it('counts a target missing from the weights as 1', () => {
    const route = weighted({ a: 1 });
    expect(run(route, { rng: () => 0.9 }).order).toEqual(['c', 'a', 'b']);
  });

  it('shares first place in proportion to the weights over seeded draws', () => {
    const route = weighted({ a: 80, b: 20 });
    const rng = seededRng(7);
    const first = { a: 0, b: 0 };
    for (let i = 0; i < 10_000; i++) {
      const head = run(route, { rng, targets: ['a', 'b'] }).order[0] as 'a' | 'b';
      first[head]++;
    }
    expect(first.a / 10_000).toBeGreaterThan(0.77);
    expect(first.a / 10_000).toBeLessThan(0.83);
  });

  it('never picks a zero weight first while another target has weight', () => {
    const route = weighted({ a: 0, b: 1 });
    const rng = seededRng(3);
    for (let i = 0; i < 200; i++) {
      expect(run(route, { rng, targets: ['a', 'b'] }).order).toEqual(['b', 'a']);
    }
  });

  it('falls back to declared order inside a tier where every weight is 0', () => {
    const route = {
      name: 'w',
      targets: [['a'], ['b', 'c']],
      strategy: { type: 'weighted' as const, weights: { a: 1, b: 0, c: 0 } },
    };
    expect(run(route, { rng: () => 0.99 }).order).toEqual(['a', 'b', 'c']);
  });

  it('uses the sticky unit instead of drawing', () => {
    const route = weighted({ a: 1, b: 1, c: 1 }, 'user');
    let draws = 0;
    const rng = () => (draws++, 0);
    expect(run(route, { rng, stickyUnit: 0.7 }).order[0]).toBe('c');
    expect(run(route, { rng, stickyUnit: 0.1 }).order[0]).toBe('a');
    expect(draws).toBe(0);
  });

  it('runs the strategy inside each tier and the next tier only after the previous one', () => {
    const route = {
      name: 'w',
      targets: [['a', 'b'], ['c']],
      strategy: { type: 'weighted' as const, weights: { a: 1, b: 1, c: 1 } },
    };
    const orders = new Set<string>();
    const rng = seededRng(11);
    for (let i = 0; i < 100; i++) orders.add(run(route, { rng }).order.join(''));
    expect([...orders].sort()).toEqual(['abc', 'bac']);
  });
});

describe('hash', () => {
  it('is stable per key and spreads different keys over [0, 1)', () => {
    expect(hash32('user-1')).toBe(hash32('user-1'));
    expect(hash32('user-1')).not.toBe(hash32('user-2'));

    const units = Array.from({ length: 1000 }, (_, i) => hashUnit(`user-${i}`));
    expect(units.every((unit) => unit >= 0 && unit < 1)).toBe(true);
    const low = units.filter((unit) => unit < 0.5).length;
    expect(low).toBeGreaterThan(450);
    expect(low).toBeLessThan(550);
  });
});
