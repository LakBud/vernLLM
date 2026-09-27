import { LLMError } from '../../../types/errors.js';
import { MAX_TIMER_DELAY_MS } from '../../execution/utils/deadline.utils.js';

import type { AimdOptions, RateLimitOptions } from '../../../rateLimit.js';

/**
 * Validates `estimateFraction`. Non-finite or `<= 0` would zero or invert the reservation, so it
 * throws; above 1 is only wasteful, so it is clamped.
 */
export function buildEstimateFraction(fraction: number | undefined): number {
  if (fraction === undefined) return 1;

  if (!Number.isFinite(fraction) || fraction <= 0) {
    throw new LLMError(
      `estimateFraction (${fraction}) must be a finite number greater than 0.`,
      'invalid_params',
    );
  }

  return Math.min(fraction, 1);
}

/**
 * Validates and clamps `AimdOptions`. An out of range `decreaseFactor` or negative `increaseBy` is
 * clamped. `minCapacity` above `maxCapacity`, or either below 1, throws: every acquire takes 1, and
 * a ceiling of 0 would also zero the refill rate with no way back.
 */
export function buildAimdOptions(option: AimdOptions | undefined): AimdOptions | undefined {
  if (!option) return undefined;

  const assertFinite = (name: 'minCapacity' | 'maxCapacity' | 'increaseBy' | 'decreaseFactor') => {
    if (!Number.isFinite(option[name])) {
      throw new LLMError(
        `aimd.${name} (${option[name]}) must be a finite number.`,
        'invalid_params',
      );
    }
  };

  for (const name of ['minCapacity', 'maxCapacity', 'increaseBy', 'decreaseFactor'] as const) {
    assertFinite(name);
  }

  if (option.minCapacity < 1 || option.maxCapacity < 1) {
    throw new LLMError(
      `aimd.minCapacity (${option.minCapacity}) and aimd.maxCapacity (${option.maxCapacity}) must both be at least 1, since the requests bucket always takes 1 per acquire; a capacity below 1 could never be satisfied.`,
      'invalid_params',
    );
  }

  if (option.minCapacity > option.maxCapacity) {
    throw new LLMError(
      `aimd.minCapacity (${option.minCapacity}) must not exceed aimd.maxCapacity (${option.maxCapacity}).`,
      'invalid_params',
    );
  }

  return {
    increaseBy: Math.max(0, option.increaseBy),
    decreaseFactor: Math.min(1, Math.max(Number.MIN_VALUE, option.decreaseFactor)),
    minCapacity: option.minCapacity,
    maxCapacity: option.maxCapacity,
    proactiveFloor: option.proactiveFloor ?? 0,
  };
}

/**
 * Validates the bucket and queue limits. Each mistake would otherwise misbehave silently: NaN reads
 * as unlimited, a negative ceiling blocks everything, `Infinity` or an out of range `maxQueueMs`
 * times out at once, and a ceiling between 0 and 1 can never be met. `0` stays valid where it means
 * unlimited.
 */
export function assertValidLimits(options: RateLimitOptions): void {
  const invalid = (message: string): never => {
    throw new LLMError(message, 'invalid_params');
  };

  for (const name of ['requestsPerMinute', 'tokensPerMinute'] as const) {
    const value = options[name];
    if (value === undefined || value === 0) continue;

    if (!Number.isFinite(value) || value < 1) {
      invalid(`${name} (${value}) must be 0 (unlimited) or a finite number of at least 1.`);
    }
  }

  // A fractional slot count can't describe calls in flight.
  for (const name of ['maxConcurrent', 'maxQueueSize'] as const) {
    const value = options[name];
    if (value === undefined) continue;

    if (!Number.isInteger(value) || value < 0) {
      invalid(`${name} (${value}) must be a non-negative integer (0 means unlimited).`);
    }
  }

  const { maxQueueMs } = options;
  if (
    maxQueueMs !== undefined &&
    (!Number.isFinite(maxQueueMs) || maxQueueMs < 0 || maxQueueMs > MAX_TIMER_DELAY_MS)
  ) {
    invalid(
      `maxQueueMs (${maxQueueMs}) must be a finite number from 0 to ${MAX_TIMER_DELAY_MS}. Pass 0 to wait indefinitely.`,
    );
  }

  const { aimd } = options;
  if (!aimd) return;

  // Without it there is no ceiling to adjust, so AIMD would do nothing.
  if (!options.requestsPerMinute) {
    invalid('aimd requires requestsPerMinute to be set.');
  }

  const floor = aimd.proactiveFloor;
  if (floor !== undefined && (!Number.isFinite(floor) || floor < 0)) {
    invalid(`aimd.proactiveFloor (${floor}) must be a finite number that is not negative.`);
  }
}
