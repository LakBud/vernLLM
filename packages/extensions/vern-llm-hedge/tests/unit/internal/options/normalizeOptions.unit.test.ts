import { describe, expect, it } from 'vitest';

import { hedgeMiddleware, type HedgeOptions } from '../../../../src/index.js';
import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';
import { nextTargets } from '../../../../src/targets.js';

const stats = { quantile: () => 100 };

function fails(options: HedgeOptions, message: string): void {
  expect(() => normalizeOptions(options)).toThrow(`hedgeMiddleware: ${message}`);
}

describe('defaults', () => {
  it('hedges at the p95 with a 5% budget, to the next targets, for every call', () => {
    const config = normalizeOptions({ stats });

    expect(config.delay).toEqual({
      kind: 'quantile',
      quantile: 0.95,
      minMs: 0,
      fallbackMs: undefined,
    });
    expect(config.budget).toEqual({ ratio: 0.05, burst: 10 });
    expect(config.targets).toBe(nextTargets);
    expect(config.when({} as never)).toBe(true);
    expect(config.statsTtlMs).toBe(1_000);
  });

  it('needs no stats for a number or a function delay', () => {
    expect(normalizeOptions({ delay: 800 }).delay).toEqual({ kind: 'fixed', ms: 800 });
    expect(normalizeOptions({ delay: () => 1 }).delay.kind).toBe('function');
  });

  it('is what hedgeMiddleware builds from', () => {
    const middleware = hedgeMiddleware({ stats });

    expect(middleware).toMatchObject({ name: 'hedge', position: 10, reruns: true });
  });

  it('keeps every quantile setting', () => {
    const config = normalizeOptions({
      stats,
      delay: { quantile: 0.9, minMs: 200, fallbackMs: 1_500 },
      budget: { ratio: 0.1 },
      statsTtlMs: 0,
    });

    expect(config.delay).toEqual({
      kind: 'quantile',
      quantile: 0.9,
      minMs: 200,
      fallbackMs: 1_500,
    });
    expect(config.budget).toEqual({ ratio: 0.1, burst: 10 });
    expect(config.statsTtlMs).toBe(0);
  });
});

describe('validation', () => {
  it('requires stats for a quantile delay', () => {
    fails(
      {},
      'stats must have a quantile function when delay is a quantile (pass logger.stats), or set delay to a number or a function',
    );
    fails(
      { delay: { quantile: 0.9 } },
      'stats must have a quantile function when delay is a quantile',
    );
  });

  it('checks stats whenever it is given', () => {
    fails({ stats: {} as never, delay: 100 }, 'stats must have a quantile function');
    fails({ stats: null as never, delay: 100 }, 'stats must have a quantile function');
  });

  it.each([0, -5, Number.NaN, Infinity])('rejects the numeric delay %s', (delay) => {
    fails({ delay }, 'delay must be a positive, finite number of milliseconds');
  });

  it.each([null, [], true, '800'])('rejects the delay %s', (delay) => {
    fails(
      { stats, delay: delay as never },
      'delay must be a number, a function or { quantile, minMs?, fallbackMs? }',
    );
  });

  it.each([0, 1, -0.5, 2, Number.NaN, '0.9'])('rejects delay.quantile %s', (quantile) => {
    fails(
      { stats, delay: { quantile: quantile as never } },
      'delay.quantile must be a number above 0 and below 1',
    );
  });

  it.each([-1, Number.NaN, Infinity])('rejects delay.minMs %s', (minMs) => {
    fails({ stats, delay: { quantile: 0.9, minMs } }, 'delay.minMs must be a number of at least 0');
  });

  it.each([0, -1, Number.NaN, Infinity])('rejects delay.fallbackMs %s', (fallbackMs) => {
    fails(
      { stats, delay: { quantile: 0.9, fallbackMs } },
      'delay.fallbackMs must be a positive, finite number of milliseconds',
    );
  });

  it.each([null, 'big', 3])('rejects the budget %s', (budget) => {
    fails({ stats, budget: budget as never }, 'budget must be an object: { ratio?, burst? }');
  });

  it.each([0, -0.1, 1.5, Number.NaN])('rejects budget.ratio %s', (ratio) => {
    fails({ stats, budget: { ratio } }, 'budget.ratio must be a number above 0 and at most 1');
  });

  it.each([0, 0.5, Number.NaN, -1])('rejects budget.burst %s', (burst) => {
    fails({ stats, budget: { burst } }, 'budget.burst must be a number of at least 1');
  });

  it('accepts the edges of the budget', () => {
    expect(normalizeOptions({ stats, budget: { ratio: 1, burst: 1 } }).budget).toEqual({
      ratio: 1,
      burst: 1,
    });
  });

  it.each([0, 5, 1.5, Number.NaN, '2'])('rejects maxHedges %s', (maxHedges) => {
    fails({ stats, maxHedges: maxHedges as never }, 'maxHedges must be an integer from 1 to 4');
  });

  it('accepts the edges of maxHedges, and defaults to one', () => {
    expect(normalizeOptions({ stats }).maxHedges).toBe(1);
    expect(normalizeOptions({ stats, maxHedges: 4 }).maxHedges).toBe(4);
  });

  it('leaves the adaptation off unless asked, and fills its defaults for true', () => {
    expect(normalizeOptions({ stats }).adapt).toBeUndefined();
    expect(normalizeOptions({ stats, adapt: false }).adapt).toBeUndefined();
    expect(normalizeOptions({ stats, adapt: true }).adapt).toEqual({
      window: 50,
      minHedges: 20,
      lowWinRate: 0.1,
      highWinRate: 0.5,
      quantileStep: 0.02,
      maxQuantile: 0.99,
      pauseMs: 300_000,
    });
  });

  it.each([null, [], 'on', 3])('rejects the adapt value %s', (adapt) => {
    fails({ stats, adapt: adapt as never }, 'adapt must be true or an object');
  });

  it.each([
    [{ window: 0 }, 'adapt.window must be an integer of at least 1'],
    [{ window: 1.5 }, 'adapt.window must be an integer of at least 1'],
    [{ minHedges: 0 }, 'adapt.minHedges must be an integer from 1 to adapt.window'],
    [{ window: 10, minHedges: 11 }, 'adapt.minHedges must be an integer from 1 to adapt.window'],
    [{ lowWinRate: -0.1 }, 'adapt.lowWinRate must be a number from 0 up to 1'],
    [{ lowWinRate: 1 }, 'adapt.lowWinRate must be a number from 0 up to 1'],
    [
      { lowWinRate: 0.6 },
      'adapt.highWinRate must be a number above adapt.lowWinRate and at most 1',
    ],
    [
      { highWinRate: 1.5 },
      'adapt.highWinRate must be a number above adapt.lowWinRate and at most 1',
    ],
    [{ quantileStep: 0 }, 'adapt.quantileStep must be a number above 0 and below 1'],
    [{ maxQuantile: 1 }, 'adapt.maxQuantile must be a number above 0 and below 1'],
    [{ pauseMs: 0 }, 'adapt.pauseMs must be a positive, finite number of milliseconds'],
  ])('rejects the adapt options %o', (adapt, message) => {
    fails({ stats, adapt }, message);
  });

  it('leaves cache awareness off unless asked, and fills its defaults for true', () => {
    expect(normalizeOptions({ stats }).cacheAware).toBeUndefined();
    expect(normalizeOptions({ stats, cacheAware: false }).cacheAware).toBeUndefined();
    expect(normalizeOptions({ stats, cacheAware: true }).cacheAware).toEqual({
      ttlMs: 300_000,
      prefixChars: 2_000,
      action: 'delay',
      delayFactor: 2,
    });
  });

  it.each([null, [], 'on', 3])('rejects the cacheAware value %s', (cacheAware) => {
    fails({ stats, cacheAware: cacheAware as never }, 'cacheAware must be true or an object');
  });

  it.each([
    [{ ttlMs: 0 }, 'cacheAware.ttlMs must be a positive, finite number of milliseconds'],
    [{ prefixChars: 0 }, 'cacheAware.prefixChars must be an integer of at least 1'],
    [{ prefixChars: 1.5 }, 'cacheAware.prefixChars must be an integer of at least 1'],
    [{ action: 'wait' }, "cacheAware.action must be 'delay' or 'skip'"],
    [{ delayFactor: 1 }, 'cacheAware.delayFactor must be a number above 1'],
  ])('rejects the cacheAware options %o', (cacheAware, message) => {
    fails({ stats, cacheAware: cacheAware as never }, message);
  });

  it('requires targets and when to be functions', () => {
    fails({ stats, targets: [] as never }, 'targets must be a function');
    fails({ stats, when: true as never }, 'when must be a function');
  });

  it.each([-1, Number.NaN, Infinity])('rejects statsTtlMs %s', (statsTtlMs) => {
    fails({ stats, statsTtlMs }, 'statsTtlMs must be a number of at least 0');
  });
});
