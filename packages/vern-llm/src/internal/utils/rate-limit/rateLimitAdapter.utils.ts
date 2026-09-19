import { RateLimiter, type RateLimiterAdapter, type RateLimitOptions } from '../../../rateLimit.js';
import { LLMError } from '../../../types/errors.js';

import type { Logger } from '../../../logger.js';

/** Not exported. Internal shorthand only, so this union isn't duplicated between the public option fields and `buildRateLimit`'s own signature. */
export type RateLimitOption = RateLimitOptions | RateLimiterAdapter;

const ADAPTER_METHOD_NAMES = [
  'estimate',
  'acquire',
  'signalRateLimit',
  'reactToRateLimitHint',
] as const;

/** Optional `RateLimiterAdapter` members that must be functions when present. */
const OPTIONAL_FUNCTION_MEMBER_NAMES = ['getState', 'readState', 'setLogger'] as const;

/**
 * The optional members that are present but not callable, e.g. someone
 * accidentally assigned a plain object instead of a function. Caught here
 * rather than left to surface later as a confusing "getState is not a
 * function" the first time `getRateLimitState()` calls it: `?.()` only
 * guards against `null`/`undefined`, not a present-but-wrong-type value.
 */
function invalidOptionalMembers(
  option: RateLimitOption,
): (typeof OPTIONAL_FUNCTION_MEMBER_NAMES)[number][] {
  const candidate = option as Partial<RateLimiterAdapter>;
  return OPTIONAL_FUNCTION_MEMBER_NAMES.filter(
    (name) => candidate[name] !== undefined && typeof candidate[name] !== 'function',
  );
}

/** All four required `RateLimiterAdapter` methods present and callable, and the optional ones (if present at all) also callable. They stay optional, see `invalidOptionalMembers`. */
function isRateLimiterAdapter(option: RateLimitOption): option is RateLimiterAdapter {
  const candidate = option as Partial<RateLimiterAdapter>;
  return (
    ADAPTER_METHOD_NAMES.every((name) => typeof candidate[name] === 'function') &&
    invalidOptionalMembers(option).length === 0
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
 * present-but-non-function optional member.
 */
export function buildRateLimit(
  option: RateLimitOption | undefined,
  logger?: Logger,
): RateLimiterAdapter | undefined {
  if (option === undefined) return undefined;
  if (isRateLimiterAdapter(option)) {
    if (logger) option.setLogger?.(logger);
    return option;
  }

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

  const invalid = invalidOptionalMembers(option);
  if (invalid.length > 0) {
    const candidate = option as Partial<RateLimiterAdapter>;
    const described = invalid.map((name) => `${name} (${typeof candidate[name]})`).join(', ');

    throw new LLMError(
      `rateLimit's ${described} must be a function. ${invalid.length === 1 ? 'It is' : 'They are'} optional; omit entirely rather than assigning a non-function value.`,
      'invalid_params',
    );
  }

  return new RateLimiter(option);
}
