import { describe, expect, it } from 'vitest';

import {
  outputTokensPerSec,
  roundMs,
} from '../../../../src/internal/recorder/recordMetrics.utils.js';

describe('outputTokensPerSec', () => {
  it('divides tokens by seconds', () => {
    expect(outputTokensPerSec(100, 2000)).toBe(50);
  });

  it.each([
    [undefined, 100],
    [10, undefined],
    [0, 100],
    [-5, 100],
    [10, 0],
    [10, -1],
    [Number.NaN, 100],
    [Number.POSITIVE_INFINITY, 100],
  ])('is undefined for tokens %j over %j ms', (tokens, ms) => {
    expect(outputTokensPerSec(tokens, ms)).toBeUndefined();
  });
});

describe('roundMs', () => {
  it('keeps microseconds and nothing finer', () => {
    expect(roundMs(1.23456)).toBe(1.235);
    expect(roundMs(0)).toBe(0);
  });
});
