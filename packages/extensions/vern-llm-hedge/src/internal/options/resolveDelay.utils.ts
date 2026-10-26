import { invalid, isNumber, isPositive } from './validate.utils.js';

import type { HedgeOptions, ResolvedDelay } from '../../types/index.js';

/** The delay as one of three shapes, with every default filled in. */
export function resolveDelay(delay: HedgeOptions['delay']): ResolvedDelay {
  if (delay === undefined)
    return { kind: 'quantile', quantile: 0.95, minMs: 0, fallbackMs: undefined };

  if (typeof delay === 'function') return { kind: 'function', fn: delay };

  if (typeof delay === 'number') {
    if (!isPositive(delay)) invalid('delay must be a positive, finite number of milliseconds');
    return { kind: 'fixed', ms: delay };
  }

  if (typeof delay !== 'object' || delay === null || Array.isArray(delay)) {
    invalid('delay must be a number, a function or { quantile, minMs?, fallbackMs? }');
  }

  if (!isNumber(delay.quantile) || delay.quantile <= 0 || delay.quantile >= 1) {
    invalid('delay.quantile must be a number above 0 and below 1');
  }
  if (delay.minMs !== undefined && (!isNumber(delay.minMs) || delay.minMs < 0)) {
    invalid('delay.minMs must be a number of at least 0');
  }
  if (delay.fallbackMs !== undefined && !isPositive(delay.fallbackMs)) {
    invalid('delay.fallbackMs must be a positive, finite number of milliseconds');
  }

  return {
    kind: 'quantile',
    quantile: delay.quantile,
    minMs: delay.minMs ?? 0,
    fallbackMs: delay.fallbackMs,
  };
}
