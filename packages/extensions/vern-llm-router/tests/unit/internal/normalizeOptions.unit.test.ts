import { describe, expect, it } from 'vitest';

import { normalizeOptions } from '../../../src/internal/options/normalizeOptions.utils.js';

const stats = { quantile: () => 1, failureRate: () => 0 };
const cost = () => 1;

describe('normalizeOptions', () => {
  it('defaults to applying, with no routes', () => {
    const config = normalizeOptions();
    expect(config).toMatchObject({ apply: true, logger: undefined });
    expect(config.routes).toEqual([]);
    expect(config.capabilities.size).toBe(0);
  });

  it('splits targets into tiers', () => {
    const config = normalizeOptions({ routes: [{ name: 'r', targets: ['a', ['b', 'c'], '*'] }] });
    expect(config.routes[0]?.tiers).toEqual([['a'], ['b', 'c'], ['*']]);
  });

  it('groups consecutive bare names into one tier and keeps * alone', () => {
    const tiers = (targets: unknown[]) =>
      normalizeOptions({ routes: [{ name: 'r', targets: targets as never }] }).routes[0]?.tiers;
    expect(tiers(['a', 'b'])).toEqual([['a', 'b']]);
    expect(tiers(['a', 'b', '*'])).toEqual([['a', 'b'], ['*']]);
    expect(tiers([['a'], 'b', 'c', ['d']])).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it.each([
    ['an unnamed route', { routes: [{ name: '' }] }, 'non empty name'],
    ['a duplicate name', { routes: [{ name: 'a', when: {} }, { name: 'a' }] }, 'used twice'],
    ['a middle route without when', { routes: [{ name: 'a' }, { name: 'b' }] }, 'last route'],
    ['an unknown strategy', { routes: [{ name: 'a', strategy: 'fastest' }] }, 'unknown strategy'],
    [
      'a rank without weights',
      { routes: [{ name: 'a', strategy: { type: 'rank' } }] },
      'needs a metric',
    ],
    [
      'an inherited object key as strategy',
      { routes: [{ name: 'a', strategy: 'toString' }] },
      'unknown strategy',
    ],
    [
      'an object strategy of the wrong type',
      { routes: [{ name: 'a', strategy: { type: 'x' } }] },
      'unknown strategy',
    ],
    ['empty targets', { routes: [{ name: 'a', targets: [] }] }, 'non empty list'],
    ['an empty tier', { routes: [{ name: 'a', targets: [[]] }] }, 'cannot be empty'],
    ['a blank target', { routes: [{ name: 'a', targets: [''] }] }, 'non empty strings'],
    ['a repeated target', { routes: [{ name: 'a', targets: ['x', ['x']] }] }, 'listed twice'],
    ['a shared * tier', { routes: [{ name: 'a', targets: [['x', '*']] }] }, 'stand alone'],
    ['a bad exclude', { routes: [{ name: 'a', exclude: [1] }] }, 'exclude must be'],
    [
      'an exclude covering every listed target',
      { routes: [{ name: 'a', targets: ['x', ['y']], exclude: ['x', 'y'] }] },
      'removes every target',
    ],
    ['a non object when', { routes: [{ name: 'a', when: 'x' }] }, 'conditions object'],
    ['an array when', { routes: [{ name: 'a', when: [] }] }, 'conditions object'],
    ['a non boolean hasTools', { routes: [{ name: 'a', when: { hasTools: 1 } }] }, 'hasTools must'],
    [
      'a non boolean jsonOutput',
      { routes: [{ name: 'a', when: { jsonOutput: 'y' } }] },
      'jsonOutput',
    ],
    [
      'a non finite minInputTokens',
      { routes: [{ name: 'a', when: { minInputTokens: Infinity } }] },
      'minInputTokens must be a finite number',
    ],
    [
      'a string maxInputTokens',
      { routes: [{ name: 'a', when: { maxInputTokens: '5' } }] },
      'maxInputTokens must be a finite number',
    ],
    ['a null context', { routes: [{ name: 'a', when: { context: null } }] }, 'context must be'],
    ['a bad window', { capabilities: { a: { contextWindow: 0 } } }, 'positive number'],
    [
      'weighted without weights',
      { routes: [{ name: 'a', strategy: { type: 'weighted' } }] },
      'weighted needs weights',
    ],
    [
      'weights that are not an object',
      { routes: [{ name: 'a', strategy: { type: 'weighted', weights: [1] } }] },
      'weights must be an object',
    ],
    [
      'a negative weight',
      { routes: [{ name: 'a', strategy: { type: 'least-busy', weights: { x: -1 } } }] },
      'at least 0',
    ],
    [
      'a weight that is not a number',
      { routes: [{ name: 'a', strategy: { type: 'weighted', weights: { x: '1' } } }] },
      'at least 0',
    ],
    [
      'weights that are all zero',
      { routes: [{ name: 'a', strategy: { type: 'weighted', weights: { x: 0, y: 0 } } }] },
      'cannot all be 0',
    ],
    [
      'an empty stickyBy',
      { routes: [{ name: 'a', strategy: { type: 'weighted', weights: { x: 1 }, stickyBy: '' } }] },
      'stickyBy must be',
    ],
    [
      'rank without a metric',
      { routes: [{ name: 'a', strategy: { type: 'rank', weights: {} } }] },
      'needs a metric',
    ],
    [
      'an unknown rank metric',
      { stats, cost, routes: [{ name: 'a', strategy: { type: 'rank', weights: { speed: 1 } } }] },
      'unknown rank metric',
    ],
    [
      'a bad q',
      { stats, routes: [{ name: 'a', strategy: { type: 'rank', weights: { latency: 1 }, q: 1 } }] },
      'q must be',
    ],
    [
      'a negative tolerance',
      {
        stats,
        routes: [{ name: 'a', strategy: { type: 'rank', weights: { latency: 1 }, tolerance: -1 } }],
      },
      'tolerance must be',
    ],
    [
      'explore of 1',
      {
        stats,
        routes: [{ name: 'a', strategy: { type: 'rank', weights: { latency: 1 }, explore: 1 } }],
      },
      'explore must be',
    ],
    [
      'latency without stats',
      { routes: [{ name: 'a', strategy: 'latency' }] },
      'needs the stats option',
    ],
    ['cost without cost', { routes: [{ name: 'a', strategy: 'cost' }] }, 'needs the cost option'],
    [
      'quality without failureRate',
      {
        stats: { quantile: () => 1 },
        routes: [{ name: 'a', strategy: { type: 'rank', weights: { quality: 1 } } }],
      },
      'stats.failureRate',
    ],
    [
      'effectiveCost without cost',
      { stats, routes: [{ name: 'a', strategy: { type: 'rank', weights: { effectiveCost: 1 } } }] },
      'needs the cost option',
    ],
    [
      'custom without a function',
      { routes: [{ name: 'a', strategy: { type: 'rank', weights: { custom: 1 } } }] },
      'needs a custom function',
    ],
    [
      'a limits value of 0',
      { stats, routes: [{ name: 'a', limits: { latencyMs: 0 } }] },
      'must be a positive number',
    ],
    [
      'a quality limit over 1',
      { stats, routes: [{ name: 'a', limits: { qualityFailureRate: 2 } }] },
      'at most 1',
    ],
    [
      'latencyMs limit without stats',
      { routes: [{ name: 'a', limits: { latencyMs: 5 } }] },
      'needs the stats option',
    ],
    [
      'costUsd limit without cost',
      { routes: [{ name: 'a', limits: { costUsd: 5 } }] },
      'needs the cost option',
    ],
    [
      'a quality limit without failureRate',
      {
        stats: { quantile: () => 1 },
        routes: [{ name: 'a', limits: { qualityFailureRate: 0.5 } }],
      },
      'stats.failureRate',
    ],
    [
      'limits that are not an object',
      { routes: [{ name: 'a', limits: 5 }] },
      'limits must be an object',
    ],
    ['stats without quantile', { stats: {} }, 'stats must have'],
    ['a non function cost', { cost: 1 }, 'cost must be a function'],
    ['a negative statsTtlMs', { statsTtlMs: -1 }, 'statsTtlMs must be'],
    ['a non boolean apply', { apply: 'no' }, 'apply must be a boolean'],
    ['a non function health', { health: {} }, 'health must be a function'],
    ['a non function random', { random: 1 }, 'random must be a function'],
    ['a negative slowStartMs', { slowStartMs: -1 }, 'slowStartMs must be'],
    ['a holdBack that is not an array', { holdBack: {} }, 'holdBack must be an array'],
    ['a holdBack rule without an event', { holdBack: [{}] }, 'holdBack[0]: event must be'],
    ['a holdBack holdMs of 0', { holdBack: [{ event: 'x', holdMs: 0 }] }, 'holdMs must be'],
    [
      'a holdBack filter of an object',
      { holdBack: [{ event: 'x', when: { a: {} } }] },
      'when "a" must be',
    ],
    [
      'a non boolean route health',
      { routes: [{ name: 'a', health: 'off' }] },
      'health must be a boolean',
    ],
  ])('rejects %s', (_label, options, message) => {
    expect(() => normalizeOptions(options as never)).toThrow(message);
  });

  it('defaults slowStartMs to 30 seconds and route health to on', () => {
    const config = normalizeOptions({ routes: [{ name: 'a' }] });
    expect(config.slowStartMs).toBe(30_000);
    expect(config.routes[0]?.health).toBe(true);
    expect(normalizeOptions({ routes: [{ name: 'a', health: false }] }).routes[0]?.health).toBe(
      false,
    );
  });

  it('resolves holdBack rules with a default and a capped hold', () => {
    expect(normalizeOptions().holdBack).toEqual([]);
    expect(
      normalizeOptions({
        holdBack: [
          { event: 'a', when: { k: 'v' } },
          { event: 'b', holdMs: 600_000 },
        ],
      }).holdBack,
    ).toEqual([
      { event: 'a', when: [['k', 'v']], holdMs: 10_000 },
      { event: 'b', when: [], holdMs: 60_000 },
    ]);
  });

  it('resolves weighted and least-busy strategies', () => {
    const config = normalizeOptions({
      routes: [
        {
          name: 'w',
          when: () => true,
          strategy: { type: 'weighted', weights: { a: 3 }, stickyBy: 'user' },
        },
        { name: 'l', when: () => true, strategy: 'least-busy' },
        { name: 'm', strategy: { type: 'least-busy', weights: { b: 2 } } },
      ],
    });
    expect(config.routes[0]?.strategy).toEqual({
      type: 'weighted',
      weights: new Map([['a', 3]]),
      stickyBy: 'user',
    });
    expect(config.routes[1]?.strategy).toEqual({ type: 'least-busy', weights: undefined });
    expect(config.routes[2]?.strategy).toEqual({
      type: 'least-busy',
      weights: new Map([['b', 2]]),
    });
  });

  it('resolves rank with defaults, and the shorthands', () => {
    const config = normalizeOptions({
      stats,
      cost,
      routes: [
        { name: 'a', when: () => true, strategy: 'balanced' },
        { name: 'b', when: () => true, strategy: 'latency' },
        {
          name: 'c',
          when: () => true,
          strategy: { type: 'rank', weights: { cost: 2, quality: 0 } },
        },
        { name: 'd', limits: { latencyMs: 5, costUsd: 1, qualityFailureRate: 0.5 } },
      ],
    });
    expect(config.routes[0]?.strategy).toMatchObject({
      type: 'rank',
      weights: new Map([
        ['latency', 0.5],
        ['cost', 0.5],
      ]),
      q: 0.95,
      tolerance: 0.2,
      explore: 0.05,
    });
    expect(config.routes[1]?.strategy).toMatchObject({ weights: new Map([['latency', 1]]) });
    expect(config.routes[2]?.strategy).toMatchObject({ weights: new Map([['cost', 2]]) });
    expect(config.routes[3]?.limits).toEqual({ latencyMs: 5, costUsd: 1, qualityFailureRate: 0.5 });
    expect(config.statsTtlMs).toBe(1000);
  });

  it('accepts the object form of ordered', () => {
    const config = normalizeOptions({ routes: [{ name: 'a', strategy: { type: 'ordered' } }] });
    expect(config.routes[0]?.strategy).toEqual({ type: 'ordered' });
  });
});
