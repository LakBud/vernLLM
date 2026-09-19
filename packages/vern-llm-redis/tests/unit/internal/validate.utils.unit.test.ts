import { describe, expect, it } from 'vitest';

import {
  assertNonNegativeFinite,
  assertNonNegativeInteger,
  assertPositiveFinite,
  invalidParams,
} from '../../../src/internal/validate.utils.js';

describe('invalidParams', () => {
  it('throws an LLMError of type invalid_params with no code', () => {
    expect(() => invalidParams('bad')).toThrow(
      expect.objectContaining({ type: 'invalid_params', message: 'bad', code: undefined }),
    );
  });
});

describe('assertNonNegativeFinite', () => {
  it.each([undefined, 0, 1, 2.5])('accepts %s', (value) => {
    expect(() => assertNonNegativeFinite('x', value)).not.toThrow();
  });

  it.each([-1, Number.NaN, Infinity, -Infinity])(
    'rejects %s, naming the option and value',
    (value) => {
      expect(() => assertNonNegativeFinite('x', value)).toThrow(
        `x must be a finite number that is not negative (got ${value}).`,
      );
    },
  );
});

describe('assertPositiveFinite', () => {
  it.each([undefined, 1, 0.5])('accepts %s', (value) => {
    expect(() => assertPositiveFinite('x', value)).not.toThrow();
  });

  it.each([0, -1, Number.NaN, Infinity])('rejects %s, naming the option and value', (value) => {
    expect(() => assertPositiveFinite('x', value)).toThrow(
      `x must be a finite number greater than 0 (got ${value}).`,
    );
  });
});

describe('assertNonNegativeInteger', () => {
  it.each([undefined, 0, 3])('accepts %s', (value) => {
    expect(() => assertNonNegativeInteger('x', value)).not.toThrow();
  });

  it.each([-1, 1.5, Number.NaN, Infinity])('rejects %s, naming the option and value', (value) => {
    expect(() => assertNonNegativeInteger('x', value)).toThrow(
      `x must be a non-negative integer (got ${value}).`,
    );
  });
});
