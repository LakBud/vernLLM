import { describe, it, expect } from 'vitest';

import { validateMinCalls, validateRatio } from '../../../../src/internal/utils/validate.utils.js';

describe('validateMinCalls', () => {
  it('accepts 0 and any positive integer', () => {
    expect(() => validateMinCalls(0)).not.toThrow();
    expect(() => validateMinCalls(1)).not.toThrow();
    expect(() => validateMinCalls(1000)).not.toThrow();
  });

  it('throws RangeError for a negative value', () => {
    expect(() => validateMinCalls(-1)).toThrow(RangeError);
  });

  it('throws RangeError for a non-integer value', () => {
    expect(() => validateMinCalls(1.5)).toThrow(RangeError);
  });

  it('throws RangeError for a non-finite value', () => {
    expect(() => validateMinCalls(Infinity)).toThrow(RangeError);
    expect(() => validateMinCalls(NaN)).toThrow(RangeError);
  });

  it('includes the given label in the thrown message', () => {
    expect(() => validateMinCalls(-1, 'minCalls')).toThrow(/minCalls/);
  });
});

describe('validateRatio', () => {
  it('accepts every value in [0, 1], including both bounds', () => {
    expect(() => validateRatio(0, 'retryRatio')).not.toThrow();
    expect(() => validateRatio(1, 'retryRatio')).not.toThrow();
    expect(() => validateRatio(0.5, 'retryRatio')).not.toThrow();
  });

  it('throws RangeError below 0 or above 1', () => {
    expect(() => validateRatio(-0.01, 'retryRatio')).toThrow(RangeError);
    expect(() => validateRatio(1.01, 'retryRatio')).toThrow(RangeError);
  });

  it('throws RangeError for a non-finite value', () => {
    expect(() => validateRatio(Infinity, 'retryRatio')).toThrow(RangeError);
    expect(() => validateRatio(NaN, 'retryRatio')).toThrow(RangeError);
  });

  it('includes the given label in the thrown message', () => {
    expect(() => validateRatio(2, 'failureRatio')).toThrow(/failureRatio/);
  });
});
