import { RateLimiter, type RateLimiterAdapter, type RateLimitOptions } from '../../rateLimit.js';
import { LLMError } from '../../types/errors.js';

/** Not exported. Internal shorthand only, so this union isn't duplicated between the public option fields and `buildRateLimit`'s own signature. */
export type RateLimitOption = RateLimitOptions | RateLimiterAdapter;

const ADAPTER_METHOD_NAMES = [
  'estimate',
  'acquire',
  'signalRateLimit',
  'reactToRateLimitHint',
] as const;

/**
 * True when `getState` is present but not callable, e.g. someone
 * accidentally assigned a plain object instead of a function. Caught here
 * rather than left to surface later as a confusing "getState is not a
 * function" the first time `getRateLimitState()` calls it: `?.()` only
 * guards against `null`/`undefined`, not a present-but-wrong-type value.
 */
function hasInvalidGetState(option: RateLimitOption): boolean {
  const candidate = option as Partial<RateLimiterAdapter>;
  return candidate.getState !== undefined && typeof candidate.getState !== 'function';
}

/** All four required `RateLimiterAdapter` methods present and callable, and `getState` (if present at all) is also callable. `getState` itself stays optional, see `hasInvalidGetState`. */
function isRateLimiterAdapter(option: RateLimitOption): option is RateLimiterAdapter {
  const candidate = option as Partial<RateLimiterAdapter>;
  return (
    ADAPTER_METHOD_NAMES.every((name) => typeof candidate[name] === 'function') &&
    !hasInvalidGetState(option)
  );
}

/** At least one adapter method present, but not all four, an incomplete adapter rather than plain config. */
function isIncompleteRateLimiterAdapter(option: RateLimitOption): boolean {
  const candidate = option as Partial<RateLimiterAdapter>;
  return ADAPTER_METHOD_NAMES.some((name) => typeof candidate[name] === 'function');
}

/**
 * Resolves `rateLimit` into a real `RateLimiterAdapter`, or `undefined`.
 * Unlike `buildCache`, `undefined` has no fallback instance, no rate
 * limiting is the correct default. An object with some but not all four
 * adapter methods throws here rather than silently passing through as
 * an incomplete adapter or being misread as plain config, either of
 * which would only surface as a confusing "not a function" error later,
 * whenever the missing method first gets called. Same reasoning for a
 * present-but-non-function `getState`.
 */
export function buildRateLimit(
  option: RateLimitOption | undefined,
): RateLimiterAdapter | undefined {
  if (option === undefined) return undefined;
  if (isRateLimiterAdapter(option)) return option;

  if (isIncompleteRateLimiterAdapter(option)) {
    const missing = ADAPTER_METHOD_NAMES.filter(
      (name) => typeof (option as Partial<RateLimiterAdapter>)[name] !== 'function',
    );

    if (missing.length > 0) {
      throw new LLMError(
        `rateLimit looks like a RateLimiterAdapter but is missing: ${missing.join(', ')}. All four methods (${ADAPTER_METHOD_NAMES.join(', ')}) are required.`,
        'invalid_params',
      );
    }
  }

  if (hasInvalidGetState(option)) {
    throw new LLMError(
      `rateLimit's getState (${typeof (option as Partial<RateLimiterAdapter>).getState}) must be a function. getState is optional; omit it entirely rather than assigning a non-function value.`,
      'invalid_params',
    );
  }

  return new RateLimiter(option);
}
