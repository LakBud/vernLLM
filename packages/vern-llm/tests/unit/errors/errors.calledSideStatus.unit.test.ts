import { describe, expect, it } from 'vitest';

import { LLMError } from '../../../src/types/errors.js';

describe('LLMError.countsTowardBreaker, caller side 4xx statuses', () => {
  it.each([400, 401, 402, 403, 404, 409, 413, 422])(
    'is false for an api error with status %i',
    (status) => {
      expect(new LLMError('m', 'api', { status }).countsTowardBreaker).toBe(false);
    },
  );

  it.each([408, 425, 429])('is still true for provider side status %i', (status) => {
    expect(new LLMError('m', 'api', { status }).countsTowardBreaker).toBe(true);
  });

  it.each([500, 502, 503, 529])('is still true for 5xx status %i', (status) => {
    expect(new LLMError('m', 'api', { status }).countsTowardBreaker).toBe(true);
  });

  it('is true for an api error with no status at all', () => {
    expect(new LLMError('m', 'api').countsTowardBreaker).toBe(true);
  });
});

describe('LLMError.retryable, payload_too_large', () => {
  it('is false, since resending the same body can only fail again', () => {
    const err = new LLMError('m', 'api', { status: 413, code: 'payload_too_large' });
    expect(err.retryable).toBe(false);
    expect(err.toSnapshot().retryable).toBe(false);
  });
});
