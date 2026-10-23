import { describe, expect, it } from 'vitest';

import { decide } from '../../../src/internal/decide/decide.js';
import { normalizeOptions } from '../../../src/internal/options/normalizeOptions.utils.js';
import { seededRng } from './seededRng.js';

import type { Signals } from '../../../src/internal/decide/signals.js';
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
  inFlight: Record<string, number>,
  rng: () => number,
  weights?: Record<string, number>,
  targets = ['a', 'b', 'c'],
) {
  const signals = new Map<string, Signals>(
    Object.entries(inFlight).map(([name, count]) => [
      name,
      { limited: false, warmingFactor: 1, inFlight: count },
    ]),
  );
  const strategy = weights ? { type: 'least-busy' as const, weights } : ('least-busy' as const);
  return decide({
    targets,
    route: normalizeOptions({ routes: [{ name: 'lb', strategy }] }).routes[0],
    capabilities: new Map(),
    facts,
    signals,
    rng,
  });
}

/** Draws in order, then repeats the last. */
const draws = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] as number;
};

describe('least-busy', () => {
  it('puts the less busy of two sampled targets first, and the rest by in flight count', () => {
    // First draw picks a, the second picks among [b, c]: 0 gives b.
    const result = run({ a: 5, b: 1, c: 0 }, draws(0, 0));
    expect(result.strategy).toBe('least-busy');
    expect(result.order).toEqual(['b', 'c', 'a']);
  });

  it('does not stampede the single least loaded target: it only wins when sampled', () => {
    // Samples a and b; c has nothing in flight but is not looked at.
    const result = run({ a: 2, b: 3, c: 0 }, draws(0, 0));
    expect(result.order[0]).toBe('a');
  });

  it('breaks a tie by declared order', () => {
    expect(run({}, draws(0.99, 0)).order[0]).toBe('a');
  });

  it('divides load by weight, so a heavier target takes more', () => {
    // b has 2 in flight at weight 4 (0.5 each); a has 1 at weight 1 (1 each): b wins.
    const result = run({ a: 1, b: 2 }, draws(0, 0), { a: 1, b: 4 }, ['a', 'b']);
    expect(result.order).toEqual(['b', 'a']);
  });

  it('samples by weight, never sampling a zero weight while others have weight', () => {
    const rng = seededRng(5);
    for (let i = 0; i < 200; i++) {
      const result = run({}, rng, { a: 0, b: 1, c: 1 });
      expect(result.order[0]).not.toBe('a');
    }
  });

  it('puts a zero weight last in the contest when it is sampled against a weighted target', () => {
    const result = run({ a: 0, b: 100 }, draws(0, 0), { a: 0, b: 1 }, ['a', 'b']);
    expect(result.order[0]).toBe('b');
  });

  it('spreads load over seeded draws: the busier of two loses', () => {
    const rng = seededRng(21);
    const first = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 6_000; i++) {
      first[run({ a: 4, b: 1, c: 0 }, rng).order[0] as 'a']++;
    }
    // a only wins a pair when it faces nobody less busy, which never happens.
    expect(first.a).toBe(0);
    // b loses to c in b vs c, wins against a: it leads about 1/3 of the time, c about 2/3.
    expect(first.c / 6_000).toBeGreaterThan(0.6);
    expect(first.b / 6_000).toBeGreaterThan(0.28);
  });

  it('returns a single target as is', () => {
    expect(run({ a: 9 }, draws(0), undefined, ['a']).order).toEqual(['a']);
  });

  it('runs inside each tier', () => {
    const route = normalizeOptions({
      routes: [{ name: 'lb', targets: [['a', 'b'], ['c']], strategy: 'least-busy' }],
    }).routes[0];
    const result = decide({
      targets: ['a', 'b', 'c'],
      route,
      capabilities: new Map(),
      facts,
      signals: new Map([['a', { limited: false, warmingFactor: 1, inFlight: 3 }]]),
      rng: draws(0, 0),
    });
    expect(result.order).toEqual(['b', 'a', 'c']);
  });
});
