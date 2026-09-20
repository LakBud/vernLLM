import { describe, expect, it } from 'vitest';

import { isNonEmpty, stringify, toArguments } from '../../../../src/internal/content/json.utils.js';

describe('stringify', () => {
  it('serializes plain values', () => {
    expect(stringify({ a: [1, 'b', null] })).toBe('{"a":[1,"b",null]}');
    expect(stringify('text')).toBe('"text"');
  });

  it('returns undefined for a value JSON cannot represent', () => {
    expect(stringify(undefined)).toBeUndefined();
    expect(stringify(() => 1)).toBeUndefined();
  });

  it('returns undefined instead of throwing on a cycle', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(stringify(cyclic)).toBeUndefined();
  });

  it('returns undefined instead of throwing on a BigInt', () => {
    expect(stringify({ big: 1n })).toBeUndefined();
  });

  it('returns undefined when toJSON throws', () => {
    const hostile = {
      toJSON() {
        throw new Error('no');
      },
    };
    expect(stringify(hostile)).toBeUndefined();
  });
});

describe('toArguments', () => {
  it('returns the parsed value when the string is valid JSON', () => {
    expect(toArguments('{"city":"Oslo"}')).toEqual({ city: 'Oslo' });
    expect(toArguments('3')).toBe(3);
  });

  it('returns the raw string when it does not parse', () => {
    expect(toArguments('{"city":')).toBe('{"city":');
    expect(toArguments('')).toBe('');
  });
});

describe('isNonEmpty', () => {
  it('accepts any non empty string', () => {
    expect(isNonEmpty('a')).toBe(true);
    expect(isNonEmpty(' ')).toBe(true);
  });

  it('rejects an empty string and undefined', () => {
    expect(isNonEmpty('')).toBe(false);
    expect(isNonEmpty(undefined)).toBe(false);
  });
});
