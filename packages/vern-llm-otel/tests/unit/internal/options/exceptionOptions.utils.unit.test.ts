import { describe, expect, it } from 'vitest';

import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';

describe('recordExceptions', () => {
  it('is off by default and for false', () => {
    expect(normalizeOptions({}).exceptions).toBeUndefined();
    expect(normalizeOptions({ recordExceptions: false }).exceptions).toBeUndefined();
  });

  it('true records without a stack', () => {
    expect(normalizeOptions({ recordExceptions: true }).exceptions).toEqual({ stack: false });
  });

  it('an object defaults the stack to off and keeps an explicit choice', () => {
    expect(normalizeOptions({ recordExceptions: {} }).exceptions).toEqual({ stack: false });
    expect(normalizeOptions({ recordExceptions: { stack: true } }).exceptions).toEqual({
      stack: true,
    });
  });
});
