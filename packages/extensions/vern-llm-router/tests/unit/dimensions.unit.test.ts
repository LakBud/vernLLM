import { describe, expect, it } from 'vitest';

import { driftDimension, routeDimension } from '../../src/index.js';

const record = (decision: unknown, ...answer: [string?]) => ({
  provider: answer.length === 0 ? 'a' : answer[0],
  custom: decision === undefined ? undefined : { 'router.decision': [decision] },
});

describe('routeDimension', () => {
  it('yields the route name of the last decision', () => {
    expect(routeDimension(record({ route: 'fast' }))).toBe('fast');
    expect(
      routeDimension({ custom: { 'router.decision': [{ route: 'a' }, { route: 'b' }] } }),
    ).toBe('b');
  });

  it('yields nothing without a decision or a route', () => {
    expect(routeDimension(record(undefined))).toBeUndefined();
    expect(routeDimension(record({}))).toBeUndefined();
    expect(routeDimension(record({ route: '' }))).toBeUndefined();
    expect(routeDimension(record(null))).toBeUndefined();
  });
});

describe('driftDimension', () => {
  it('compares the first choice with who answered', () => {
    expect(driftDimension(record({ order: ['a', 'b'] }, 'a'))).toBe('no');
    expect(driftDimension(record({ order: ['a', 'b'] }, 'b'))).toBe('yes');
  });

  it('yields nothing for pinned, no answer, no decision or no order', () => {
    expect(driftDimension(record({ strategy: 'pinned', order: ['a'] }))).toBeUndefined();
    expect(driftDimension(record({ order: ['a'] }, undefined))).toBeUndefined();
    expect(driftDimension(record(undefined))).toBeUndefined();
    expect(driftDimension(record({ order: [] }))).toBeUndefined();
    expect(driftDimension(record({}))).toBeUndefined();
  });
});
