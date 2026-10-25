import { describe, expect, it } from 'vitest';

import { errorName } from '../../../src/internal/errors.utils.js';

describe('errorName', () => {
  it('names an error by its class, and anything else by its type', () => {
    expect(errorName(new TypeError('x'))).toBe('TypeError');
    expect(errorName('text')).toBe('string');
  });

  it('cuts a very long name', () => {
    const error = new Error('x');
    error.name = 'N'.repeat(200);
    expect(errorName(error)).toHaveLength(60);
  });
});
