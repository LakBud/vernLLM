import { normalizeError } from '../errors.utils.js';

import type { RateLimiterAdapter, RateLimitReason, WireRequest } from '../../../../rateLimit.js';
import type { LLMError } from '../../../../types/errors.js';

/**
 * Errors thrown while acquiring limiter capacity. Tracked by identity
 * rather than a new error code, so the error's own `type`, `code`, and
 * retry behaviour stay exactly what the limiter produced.
 */
const limiterFailures = new WeakSet<LLMError>();

/**
 * Whether `error` came from the limiter rather than the provider. Such an
 * error never counts toward the circuit breaker: no provider request was
 * made, so it says nothing about the provider's health. A shared limiter
 * that loses its backing store (Redis, say) would otherwise open a
 * healthy provider's circuit.
 */
export function isLimiterFailure(error: LLMError): boolean {
  return limiterFailures.has(error);
}

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
 * A failure from `estimate` or `acquire` is normalized to an `LLMError`
 * and marked so it never counts toward the breaker, see `isLimiterFailure`.
 */
export async function acquireRateLimit(
  limiter: RateLimiterAdapter | undefined,
  request: WireRequest,
  signal: AbortSignal | undefined,
  onRateLimited: RateLimitedEventReporter,
): Promise<{ release?: (actualTokens?: number, success?: boolean) => void }> {
  if (!limiter) return {};

  let acquired;

  try {
    acquired = await limiter.acquire(limiter.estimate(request), signal);
  } catch (error) {
    const normalized = normalizeError(error, signal);
    limiterFailures.add(normalized);
    throw normalized;
  }

  if (acquired.waitedMs > 0) {
    onRateLimited(acquired.waitedMs, acquired.reason ?? 'rpm');
  }

  return { release: acquired.release };
}
