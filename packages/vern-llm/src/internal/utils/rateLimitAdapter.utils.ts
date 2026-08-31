import { RateLimiter, type RateLimiterLike, type RateLimitOptions } from '../../rateLimit.js';

/** Not exported. Internal shorthand only, so this union isn't duplicated between the public option fields and `buildRateLimit`'s own signature. */
export type RateLimitOption = RateLimitOptions | RateLimiterLike;

/** A config object has neither `acquire` nor `estimate`, a `RateLimiterLike` always has both. */
function isRateLimiterLike(option: RateLimitOption): option is RateLimiterLike {
  const candidate = option as RateLimiterLike;
  return typeof candidate.acquire === 'function' && typeof candidate.estimate === 'function';
}

/** Resolves `rateLimit` into a real `RateLimiterLike`, or `undefined`. Unlike `buildCache`, `undefined` has no fallback instance, no rate limiting is the correct default. */
export function buildRateLimit(option: RateLimitOption | undefined): RateLimiterLike | undefined {
  if (option === undefined) return undefined;
  if (isRateLimiterLike(option)) return option;
  return new RateLimiter(option);
}
