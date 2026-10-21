import { describe, expect, it } from 'vitest';

import {
  isCount,
  isNonEmptyString,
  put,
} from '../../../../src/internal/attributes/values.utils.js';

import type { Attributes } from '@opentelemetry/api';

describe('isNonEmptyString', () => {
  it.each(['a', ' ', '0'])('accepts %j', (value) => {
    expect(isNonEmptyString(value)).toBe(true);
  });

  it.each(['', undefined, null, 0, 1, false, {}, []])('rejects %j', (value) => {
    expect(isNonEmptyString(value)).toBe(false);
  });
});

describe('isCount', () => {
  it.each([0, 1, 512, 0.5])('accepts %j', (value) => {
    expect(isCount(value)).toBe(true);
  });

  it.each([-1, -0.1, Number.NaN, Number.POSITIVE_INFINITY, '1', undefined, null, {}])(
    'rejects %j',
    (value) => {
      expect(isCount(value)).toBe(false);
    },
  );
});

describe('put', () => {
  it('writes a defined value, including falsy ones that carry meaning', () => {
    const target: Attributes = {};
    put(target, 'a', 0);
    put(target, 'b', false);
    put(target, 'c', '');
    put(target, 'd', 'x');
    expect(target).toEqual({ a: 0, b: false, c: '', d: 'x' });
  });

  it('leaves the key out when the value is undefined', () => {
    const target: Attributes = {};
    put(target, 'a', undefined);
    expect('a' in target).toBe(false);
  });

  it('overwrites an earlier value for the same key', () => {
    const target: Attributes = { a: 1 };
    put(target, 'a', 2);
    expect(target).toEqual({ a: 2 });
  });
});
