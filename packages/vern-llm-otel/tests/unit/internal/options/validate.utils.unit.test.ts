import { describe, expect, it } from 'vitest';

import {
  optionalBoolean,
  optionalFunction,
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
