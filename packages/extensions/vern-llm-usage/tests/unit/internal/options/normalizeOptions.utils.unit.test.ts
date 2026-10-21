import { describe, expect, it } from 'vitest';

import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';

import type { UsageMiddlewareOptions } from '../../../../src/index.js';

const valid: UsageMiddlewareOptions = {
  prices: { m: { input: 1, output: 2 } },
  pricesAsOf: '2026-01-01',
};

const rejects = (options: unknown, message: string) =>
  expect(() => normalizeOptions(options as UsageMiddlewareOptions)).toThrow(message);

describe('normalizeOptions', () => {
  it('converts a single cacheWrite rate for every write', () => {
    const config = normalizeOptions({
      ...valid,
      prices: { m: { input: 1, output: 2, cacheWrite: 1.25 } },
    });

    expect(config.prices?.get('m')).toMatchObject({
      cacheWrite: 1_250,
      cacheWriteByTtl: new Map(),
    });
  });

  it('fills the defaults and converts prices to nano dollars per token', () => {
    const config = normalizeOptions(valid);

    expect(config.maxPriceAgeDays).toBe(90);
    expect(config.prices?.get('m')).toEqual({
      input: 1_000,
      output: 2_000,
      cacheRead: 1_000,
      cacheWrite: 1_000,
      cacheWriteByTtl: new Map(),
      reasoning: 2_000,
    });
    expect(config.pricesAsOfMs).toBe(Date.parse('2026-01-01'));
  });

  it('keeps TTL write rates by label', () => {
    const config = normalizeOptions({
      ...valid,
      prices: { m: { input: 1, output: 2, cacheWrite: { '5m': 1.25, '1h': 2 } } },
    });

    expect(config.prices?.get('m')?.cacheWriteByTtl).toEqual(
      new Map([
        ['5m', 1_250],
        ['1h', 2_000],
      ]),
    );
  });

  it('allows priceFor without pricesAsOf, and validates one when given', () => {
    expect(normalizeOptions({ priceFor: () => undefined }).pricesAsOfMs).toBeUndefined();
    expect(
      normalizeOptions({ priceFor: () => undefined, pricesAsOf: '2026-01-01' }).pricesAsOfMs,
    ).toBe(Date.parse('2026-01-01'));
  });

  describe('rejects', () => {
    it('options that are not an object', () => {
      rejects(undefined, 'usageMiddleware: options must be an object');
      rejects([], 'usageMiddleware: options must be an object');
    });

    it('neither or both of prices and priceFor', () => {
      rejects({}, 'pass exactly one of prices or priceFor');
      rejects({ ...valid, priceFor: () => undefined }, 'pass exactly one of prices or priceFor');
    });

    it('prices without pricesAsOf', () => {
      rejects({ prices: valid.prices }, 'pricesAsOf is required with prices');
    });

    it('a pricesAsOf that is not an ISO date, or is in the future', () => {
      rejects({ ...valid, pricesAsOf: 'last week' }, 'pricesAsOf must be an ISO date');
      rejects({ ...valid, pricesAsOf: '2026-13-45' }, 'pricesAsOf must be an ISO date');
      rejects({ ...valid, pricesAsOf: '2026-02-31' }, 'pricesAsOf must be an ISO date');
      rejects({ ...valid, pricesAsOf: '2026-10-01T12:00:00' }, 'pricesAsOf must be an ISO date');
      rejects({ ...valid, pricesAsOf: 20261001 }, 'pricesAsOf must be an ISO date');
      rejects({ ...valid, pricesAsOf: '2999-01-01' }, 'pricesAsOf must not be in the future');
    });

    it('a price that is not finite or is negative, naming the model and field', () => {
      rejects(
        { ...valid, prices: { 'gpt-6': { input: -1, output: 1 } } },
        'prices["gpt-6"].input must be a finite number >= 0',
      );
      rejects(
        { ...valid, prices: { m: { input: 1, output: Number.NaN } } },
        'prices["m"].output must be a finite number >= 0',
      );
      rejects(
        { ...valid, prices: { m: { input: 1, output: 1, cacheRead: '1' } } },
        'prices["m"].cacheRead must be a finite number >= 0',
      );
    });

    it('a malformed cacheWrite', () => {
      rejects(
        { ...valid, prices: { m: { input: 1, output: 1, cacheWrite: { '': 1 } } } },
        'cacheWrite keys must be non-empty strings',
      );
      rejects(
        { ...valid, prices: { m: { input: 1, output: 1, cacheWrite: { '5m': -1 } } } },
        'prices["m"].cacheWrite.5m must be a finite number >= 0',
      );
    });

    it('prices that are not an object, or a price that is not', () => {
      rejects({ ...valid, prices: [] }, 'prices must be an object');
      rejects({ ...valid, prices: { m: 3 } }, 'prices["m"] must be an object');
    });

    it('a bad maxPriceAgeDays', () => {
      rejects({ ...valid, maxPriceAgeDays: 0 }, 'maxPriceAgeDays must be a positive number');
      rejects({ ...valid, maxPriceAgeDays: null }, 'maxPriceAgeDays must be a positive number');
    });

    it('callbacks that are not functions, and a bad logger', () => {
      rejects({ ...valid, normalizeModel: 'x' }, 'normalizeModel must be a function');
      rejects({ priceFor: 'x' }, 'priceFor must be a function');
      rejects({ ...valid, logger: 'loud' }, "logger must be a Logger or 'silent'");
    });
  });
});
