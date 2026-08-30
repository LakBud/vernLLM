import { describe, it, expect } from 'vitest';

import { LLMError, type LLMErrorType } from '../../src/types/errors.js';

/**
 * `quota_exceeded` is the one type where `retryable` and
 * `countsTowardBreaker` diverge: a quota rejection is still
 * worth retrying (e.g. after a delay), but says nothing about provider
 * health, so it shouldn't push a healthy provider's circuit toward
 * opening.
 */
const ALL_TYPES: LLMErrorType[] = [
  'timeout',
  'api',
  'network',
  'parse',
  'validation',
  'invalid_params',
  'rate_limited',
  'quota_exceeded',
  'circuit_open',
  'fallback_exhausted',
  'aborted',
  'unknown',
];

describe('LLMError.countsTowardBreaker', () => {
  it('is false for quota_exceeded even though quota_exceeded is retryable', () => {
    const err = new LLMError('quota gone', 'quota_exceeded');

    expect(err.retryable).toBe(true);
    expect(err.countsTowardBreaker).toBe(false);
  });

  it('matches retryable for every other type, unchanged from before this split existed', () => {
    for (const type of ALL_TYPES) {
      if (type === 'quota_exceeded') continue;

      const err = new LLMError('boom', type);
      expect(err.countsTowardBreaker).toBe(err.retryable);
    }
  });

  it('is false whenever retryable is already false, regardless of type', () => {
    const err = new LLMError('bad input', 'invalid_params');

    expect(err.retryable).toBe(false);
    expect(err.countsTowardBreaker).toBe(false);
  });

  it('stays false for quota_exceeded even when a code is present', () => {
    const err = new LLMError('quota gone', 'quota_exceeded', { code: 'server_error' });

    expect(err.countsTowardBreaker).toBe(false);
  });
});
