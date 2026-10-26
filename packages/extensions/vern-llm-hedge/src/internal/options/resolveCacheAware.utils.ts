import { invalid, isNumber, isPositive } from './validate.utils.js';

import type { CacheAwareOptions, HedgeOptions, ResolvedCacheAware } from '../../types/index.js';

/** Fills every default of the cache awareness and validates it. `undefined` when it is off. */
export function resolveCacheAware(
  option: HedgeOptions['cacheAware'],
): ResolvedCacheAware | undefined {
  if (option === undefined || option === false) return undefined;
  if (option !== true && (typeof option !== 'object' || option === null || Array.isArray(option))) {
    invalid('cacheAware must be true or an object');
  }

  const given: CacheAwareOptions = option === true ? {} : option;
  const resolved: ResolvedCacheAware = {
    ttlMs: given.ttlMs ?? 300_000,
    prefixChars: given.prefixChars ?? 2_000,
    action: given.action ?? 'delay',
    delayFactor: given.delayFactor ?? 2,
  };

  if (!isPositive(resolved.ttlMs)) {
    invalid('cacheAware.ttlMs must be a positive, finite number of milliseconds');
  }
  if (!Number.isInteger(resolved.prefixChars) || resolved.prefixChars < 1) {
    invalid('cacheAware.prefixChars must be an integer of at least 1');
  }
  if (resolved.action !== 'delay' && resolved.action !== 'skip') {
    invalid("cacheAware.action must be 'delay' or 'skip'");
  }
  if (!isNumber(resolved.delayFactor) || resolved.delayFactor <= 1) {
    invalid('cacheAware.delayFactor must be a number above 1');
  }
  return resolved;
}
