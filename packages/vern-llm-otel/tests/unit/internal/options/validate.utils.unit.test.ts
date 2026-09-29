import { describe, expect, it } from 'vitest';

import {
  optionalBoolean,
  optionalFunction,
  resolveMaxLength,
} from '../../../../src/internal/options/validate.utils.js';

describe('optionalBoolean', () => {
  it.each([undefined, true, false])('accepts %j', (value) => {
    expect(() => optionalBoolean(value, 'metrics')).not.toThrow();
  });

  it.each([0, 1, 'true', null, {}, () => true])('rejects %j with a named plain Error', (value) => {
    expect(() => optionalBoolean(value, 'metrics')).toThrow(
      new Error('otelMiddleware: metrics must be a boolean'),
    );
  });
});

describe('optionalFunction', () => {
  it.each([undefined, () => 1, function named() {}, async () => 1])('accepts %j', (value) => {
    expect(() => optionalFunction(value, 'normalizeModel')).not.toThrow();
  });

  it.each([true, 'fn', 1, null, {}, []])('rejects %j with a named plain Error', (value) => {
    expect(() => optionalFunction(value, 'normalizeModel')).toThrow(
      new Error('otelMiddleware: normalizeModel must be a function'),
    );
  });
});

describe('resolveMaxLength', () => {
  it('returns the fallback when absent', () => {
    expect(resolveMaxLength(undefined, 'x.maxLength', 8192)).toBe(8192);
  });

  it.each([1, 512, Number.POSITIVE_INFINITY])('accepts %j', (value) => {
    expect(resolveMaxLength(value, 'x.maxLength', 8192)).toBe(value);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, '10', null, {}, true])(
    'rejects %j with a named plain Error, and null is not the default',
    (value) => {
      expect(() => resolveMaxLength(value, 'x.maxLength', 8192)).toThrow(
        new Error('otelMiddleware: x.maxLength must be a positive integer or Infinity'),
      );
    },
  );
});
