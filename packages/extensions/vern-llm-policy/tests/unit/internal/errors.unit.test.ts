import { describe, expect, it } from 'vitest';

import { describe as describeError, errorName } from '../../../src/internal/errors.utils.js';

describe('errorName', () => {
  it('is the name of an error', () => {
    expect(errorName(new RangeError('x'))).toBe('RangeError');
  });

  it('is the type of anything else that was thrown', () => {
    expect(errorName('text')).toBe('string');
    expect(errorName(undefined)).toBe('undefined');
  });

  it('is cut short, so a long name cannot fill a log line', () => {
    const error = Object.assign(new Error('x'), { name: 'N'.repeat(100) });
    expect(errorName(error)).toBe('N'.repeat(60));
  });
});

describe('describe', () => {
  it('is the message of an error, or the text of anything else', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('plain')).toBe('plain');
  });

  it('is cut to 200 characters and says so', () => {
    expect(describeError(new Error('m'.repeat(300)))).toBe(`${'m'.repeat(200)}...`);
  });
});
