import {
  assertNonNegativeInteger,
  assertPositiveFinite,
  invalidParams,
  resolveKeyPrefix,
} from '../shared/errors/validate.utils.js';

import type { RedisRetryBudgetOptions } from '../../retryBudget.js';

/**
 * Largest `windowMs`, about 142,000 years. The key's TTL is twice the window, and past this it
 * stops being an exact integer, which Redis rejects on every record.
 */
export const MAX_WINDOW_MS = Math.floor(Number.MAX_SAFE_INTEGER / 2);

/** Sub buckets per window, the same as core's `RollingRatio`. */
export const BUCKET_COUNT = 10;

export interface ResolvedRetryBudgetOptions {
  windowMs: number;
  minCalls: number;
  retryRatio: number;
  /** The window's hash, under `keyPrefix` so it never shares a key with another adapter. */
  key: string;
  bucketWidthMs: number;
  /** Twice the window, so an idle budget's key expires on its own. */
  ttlMs: number;
}

/** Applies defaults and throws `LLMError('invalid_params')` on the first bad value. */
export function resolveRetryBudgetOptions(
  options: RedisRetryBudgetOptions,
): ResolvedRetryBudgetOptions {
  // Checked up front: a missing options object would otherwise fail as a TypeError below.
  if (typeof options !== 'object' || options === null) {
    invalidParams('redisRetryBudget needs options with windowMs, minCalls and retryRatio.');
  }

  const { windowMs, minCalls, retryRatio } = options;

  // `undefined` passes the shared checks, but neither has a default.
  assertPositiveFinite('windowMs', windowMs ?? Number.NaN);
  if (windowMs > MAX_WINDOW_MS) {
    invalidParams(`windowMs must be at most ${MAX_WINDOW_MS} (got ${windowMs}).`);
  }
  assertNonNegativeInteger('minCalls', minCalls ?? Number.NaN);
  if (!Number.isFinite(retryRatio) || retryRatio < 0 || retryRatio > 1) {
    invalidParams(`retryRatio must be a finite number from 0 to 1 (got ${retryRatio}).`);
  }

  return {
    windowMs,
    minCalls,
    retryRatio,
    key: `${resolveKeyPrefix(options.keyPrefix, 'vernllm:rb')}:window`,
    bucketWidthMs: windowMs / BUCKET_COUNT,
    // PEXPIRE takes whole milliseconds of at least 1.
    ttlMs: Math.max(1, Math.ceil(windowMs * 2)),
  };
}
