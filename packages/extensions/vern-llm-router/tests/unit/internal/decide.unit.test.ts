import { describe, expect, it } from 'vitest';

import { decide, pinnedDecision, unknownTargetsOf } from '../../../src/internal/decide/decide.js';
import { normalizeOptions } from '../../../src/internal/options/normalizeOptions.utils.js';

import type { RequestFacts } from '../../../src/internal/match/requestFacts.utils.js';

const facts: RequestFacts = {
  hasTools: false,
  jsonOutput: false,
  jsonSchema: false,
  images: false,
  maxTokens: 10,
  inputTokens: 50,
};

const route = (options: Parameters<typeof normalizeOptions>[0]) =>
  normalizeOptions(options).routes[0];

describe('decide', () => {
  it('is synchronous and returns a plain object', () => {
    const decision = decide({ targets: ['a'], route: undefined, capabilities: new Map(), facts });
    expect(decision).not.toHaveProperty('then');
    expect(decision.order).toEqual(['a']);
  });

  it('excludes by image support', () => {
    const decision = decide({
      targets: ['a', 'b'],
      route: undefined,
      capabilities: new Map([['a', { images: false }]]),
      facts: { ...facts, images: true },
    });
    expect(decision.order).toEqual(['b']);
  });

  it('puts * where it stands among named tiers', () => {
    const decision = decide({
      targets: ['a', 'b', 'c'],
      route: route({ routes: [{ name: 'r', targets: ['c', '*'] }] }),
      capabilities: new Map(),
      facts,
    });
    expect(decision.order).toEqual(['c', 'a', 'b']);
  });

  it('applies exclude together with * and names the reason', () => {
    const decision = decide({
      targets: ['a', 'b', 'c'],
      route: route({ routes: [{ name: 'r', targets: ['*'], exclude: ['b'] }] }),
      capabilities: new Map(),
      facts,
    });
    expect(decision.order).toEqual(['a', 'c']);
    expect(decision.excluded).toEqual([{ target: 'b', reason: 'route' }]);
  });
});

describe('pinnedDecision', () => {
  it('copies the order and marks it pinned', () => {
    const names = ['x', 'y'];
    const decision = pinnedDecision(names);
    names.push('z');
    expect(decision).toEqual({
      strategy: 'pinned',
      order: ['x', 'y'],
      excluded: [],
      demoted: [],
      explored: false,
    });
  });
});

describe('unknownTargetsOf', () => {
  it('lists names in tiers and exclude that the call lacks, never *', () => {
    const r = route({ routes: [{ name: 'r', targets: ['a', 'ghost', '*'], exclude: ['gone'] }] });
    expect(unknownTargetsOf(r!, ['a'])).toEqual(['ghost', 'gone']);
  });
});
