import { describe, expect, it } from 'vitest';

import {
  MAX_WINDOW_MS,
  resolveRetryBudgetOptions,
} from '../../../../src/internal/retry-budget/retryBudgetOptions.utils.js';

import type { RedisRetryBudgetOptions } from '../../../../src/retryBudget.js';

const valid = { windowMs: 60_000, minCalls: 10, retryRatio: 0.2 };

function invalid(options: unknown, message: string): void {
  expect(() => resolveRetryBudgetOptions(options as RedisRetryBudgetOptions)).toThrow(
    expect.objectContaining({ type: 'invalid_params', message }),
  );
}

describe('resolveRetryBudgetOptions', () => {
  it('applies the default key and derives the bucket width and ttl', () => {
    expect(resolveRetryBudgetOptions(valid)).toEqual({
      ...valid,
      key: 'vernllm:rb:window',
      bucketWidthMs: 6000,
      ttlMs: 120_000,
    });
  });

  it('puts the key under a given prefix', () => {
    expect(resolveRetryBudgetOptions({ ...valid, keyPrefix: 'app:rb' }).key).toBe('app:rb:window');
  });

  it('rejects an empty keyPrefix', () => {
    invalid({ ...valid, keyPrefix: '' }, 'keyPrefix must be a non-empty string (got "").');
  });

  it('rounds the ttl up to whole milliseconds, never below 1', () => {
    expect(resolveRetryBudgetOptions({ ...valid, windowMs: 0.2 }).ttlMs).toBe(1);
    expect(resolveRetryBudgetOptions({ ...valid, windowMs: 10.3 }).ttlMs).toBe(21);
  });

  it('accepts windowMs up to the cap and rejects it past', () => {
    expect(resolveRetryBudgetOptions({ ...valid, windowMs: MAX_WINDOW_MS }).ttlMs).toBe(
      MAX_WINDOW_MS * 2,
    );
    invalid({ ...valid, windowMs: 1e21 }, `windowMs must be at most ${MAX_WINDOW_MS} (got 1e+21).`);
  });

  it('accepts the edges of minCalls and retryRatio', () => {
    expect(() => resolveRetryBudgetOptions({ ...valid, minCalls: 0, retryRatio: 0 })).not.toThrow();
    expect(() => resolveRetryBudgetOptions({ ...valid, retryRatio: 1 })).not.toThrow();
  });

  it('rejects missing options', () => {
    const message = 'redisRetryBudget needs options with windowMs, minCalls and retryRatio.';
    invalid(undefined, message);
    invalid(null, message);
    invalid('fast', message);
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects windowMs %s',
    (windowMs) => {
      invalid(
        { ...valid, windowMs },
        `windowMs must be a finite number greater than 0 (got ${windowMs ?? Number.NaN}).`,
      );
    },
  );

  it.each([undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects minCalls %s',
    (minCalls) => {
      invalid(
        { ...valid, minCalls },
        `minCalls must be a non-negative integer (got ${minCalls ?? Number.NaN}).`,
      );
    },
  );

  it.each([undefined, -0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects retryRatio %s',
    (retryRatio) => {
      invalid(
        { ...valid, retryRatio },
        `retryRatio must be a finite number from 0 to 1 (got ${retryRatio}).`,
      );
    },
  );
});
