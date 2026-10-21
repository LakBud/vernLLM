import { describe, expect, it } from 'vitest';

import {
  normalizeAttribute,
  normalizeBudgets,
  normalizeMaxSeries,
  normalizeOnStoreError,
  normalizeStore,
  normalizeTimeZone,
  normalizeWarnAt,
} from '../../../../src/internal/options/budgetOptions.utils.js';

const attribute = ['tenantId'];
const ok = { key: 'tenantId', limitUsd: 5, per: 'day' };

describe('budget options', () => {
  it('converts dollars to nano dollars and keeps token limits as they are', () => {
    expect(
      normalizeBudgets([ok, { ...ok, limitUsd: undefined, limitTokens: 500 }], attribute),
    ).toEqual([
      { key: 'tenantId', equals: undefined, per: 'day', unit: 'usd', limit: 5_000_000_000 },
      { key: 'tenantId', equals: undefined, per: 'day', unit: 'tokens', limit: 500 },
    ]);
  });

  it.each([
    [{ ...ok, limitTokens: 5 }, 'needs exactly one of limitUsd or limitTokens'],
    [{ key: 'tenantId', per: 'day' }, 'needs exactly one of limitUsd or limitTokens'],
    [{ ...ok, key: 'team' }, 'must be listed in attribute'],
    [{ ...ok, key: '' }, 'key must be a non-empty string'],
    [{ ...ok, per: 'week' }, "per must be 'hour', 'day' or 'month'"],
    [{ ...ok, equals: {} }, 'equals must be a string, number or boolean'],
    [{ ...ok, limitUsd: 0 }, 'limitUsd must be a positive number'],
    [{ ...ok, limitUsd: Number.NaN }, 'limitUsd must be a positive number'],
    [{ ...ok, limitUsd: 1e-12 }, 'limitUsd must be between'],
    [{ ...ok, limitUsd: 1e10 }, 'limitUsd must be between'],
    [{ key: 'tenantId', per: 'day', limitTokens: 1.5 }, 'limitTokens must be a positive integer'],
    ['nope', 'must be an object'],
  ])('rejects %j', (budget, message) => {
    expect(() => normalizeBudgets([budget], attribute)).toThrow(message);
  });

  it('rejects two budgets that would count the same spend twice', () => {
    expect(() => normalizeBudgets([ok, { ...ok, limitUsd: 9 }], attribute)).toThrow(
      'budgets[1] repeats budgets[0]',
    );
  });

  it('allows budgets that differ in equals, unit or window', () => {
    expect(
      normalizeBudgets(
        [
          ok,
          { ...ok, equals: 'acme' },
          { key: 'tenantId', limitTokens: 5, per: 'day' },
          { ...ok, per: 'hour' },
        ],
        attribute,
      ),
    ).toHaveLength(4);
  });

  it('rejects budgets that are not an array, and treats absence as none', () => {
    expect(normalizeBudgets(undefined, attribute)).toEqual([]);
    expect(() => normalizeBudgets({}, attribute)).toThrow('budgets must be an array');
  });

  it('validates and de-duplicates attribute', () => {
    expect(normalizeAttribute(undefined)).toEqual([]);
    expect(normalizeAttribute(['a', 'a', 'b'])).toEqual(['a', 'b']);
    expect(() => normalizeAttribute('a')).toThrow('array');
    expect(() => normalizeAttribute([''])).toThrow('non-empty');
  });

  it('defaults onStoreError to allow and rejects anything else', () => {
    expect(normalizeOnStoreError(undefined)).toBe('allow');
    expect(normalizeOnStoreError('deny')).toBe('deny');
    expect(() => normalizeOnStoreError('maybe')).toThrow("'allow' or 'deny'");
  });

  it('requires a store to implement all four methods', () => {
    const full = { reserve() {}, commit() {}, release() {}, read() {} };

    expect(normalizeStore(undefined)).toBeUndefined();
    expect(normalizeStore(full)).toBe(full);
    expect(() => normalizeStore({ ...full, read: undefined })).toThrow(
      'reserve, commit, release and read',
    );
  });

  it('accepts warnAt strictly between 0 and 1, and nothing else', () => {
    expect(normalizeWarnAt(undefined)).toBeUndefined();
    expect(normalizeWarnAt(0.8)).toBe(0.8);
    for (const bad of [0, 1, -0.1, 1.5, Number.NaN, '0.8']) {
      expect(() => normalizeWarnAt(bad)).toThrow('warnAt must be a number between 0 and 1');
    }
  });

  it('defaults maxSeries to 1000 and wants a positive integer', () => {
    expect(normalizeMaxSeries(undefined)).toBe(1_000);
    expect(normalizeMaxSeries(5)).toBe(5);
    for (const bad of [0, -1, 1.5, '5']) {
      expect(() => normalizeMaxSeries(bad)).toThrow('maxSeries must be a positive integer');
    }
  });
});

describe('normalizeTimeZone', () => {
  it('defaults to UTC and accepts an IANA zone', () => {
    expect(normalizeTimeZone(undefined)).toBe('UTC');
    expect(normalizeTimeZone('Europe/Paris')).toBe('Europe/Paris');
  });

  it('rejects anything else', () => {
    for (const bad of ['Mars/Base', '', 5, null]) {
      expect(() => normalizeTimeZone(bad)).toThrow('timeZone must be an IANA time zone');
    }
  });
});
