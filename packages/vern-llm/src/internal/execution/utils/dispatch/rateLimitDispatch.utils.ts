import type { RateLimitReason, RateLimiter, WireRequest } from '../../../../rateLimit.js';

/** Reports the `'rate_limited'` trace event; called only when `acquireRateLimit` actually waited. */
export type RateLimitedEventReporter = (waitedMs: number, reason: RateLimitReason) => void;

/**
 * Acquires capacity from `limiter` for one attempt, reporting the
 * `'rate_limited'` event through `onRateLimited` when the acquire had to
 * wait. A no-op, returning `{}`, when `limiter` is undefined: the caller
 * doesn't have to branch on whether a limiter is configured.
 *
 * The returned `release`, when present, must run in a `finally` block so
 * a slot is never leaked on a failed attempt (see `RateLimitAcquireResult`).
 */
export async function acquireRateLimit(
  limiter: RateLimiter | undefined,
  request: WireRequest,
  signal: AbortSignal | undefined,
  onRateLimited: RateLimitedEventReporter,
): Promise<{ release?: (actualTokens?: number, success?: boolean) => void }> {
  if (!limiter) return {};

  const acquired = await limiter.acquire(limiter.estimate(request), signal);

  if (acquired.waitedMs > 0) {
    onRateLimited(acquired.waitedMs, acquired.reason ?? 'rpm');
  }

  return { release: acquired.release };
}
