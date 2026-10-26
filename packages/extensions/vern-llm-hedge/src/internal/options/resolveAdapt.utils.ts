import { invalid, isNumber, isPositive } from './validate.utils.js';

import type { AdaptOptions, HedgeOptions, ResolvedAdapt } from '../../types/index.js';

/** Fills every default of the win rate adaptation and validates it. `undefined` when it is off. */
export function resolveAdapt(adapt: HedgeOptions['adapt']): ResolvedAdapt | undefined {
  if (adapt === undefined || adapt === false) return undefined;
  if (adapt !== true && (typeof adapt !== 'object' || adapt === null || Array.isArray(adapt))) {
    invalid('adapt must be true or an object');
  }

  const given: AdaptOptions = adapt === true ? {} : adapt;
  const resolved: ResolvedAdapt = {
    window: given.window ?? 50,
    minHedges: given.minHedges ?? 20,
    lowWinRate: given.lowWinRate ?? 0.1,
    highWinRate: given.highWinRate ?? 0.5,
    quantileStep: given.quantileStep ?? 0.02,
    maxQuantile: given.maxQuantile ?? 0.99,
    pauseMs: given.pauseMs ?? 300_000,
  };

  if (!Number.isInteger(resolved.window) || resolved.window < 1) {
    invalid('adapt.window must be an integer of at least 1');
  }
  if (
    !Number.isInteger(resolved.minHedges) ||
    resolved.minHedges < 1 ||
    resolved.minHedges > resolved.window
  ) {
    invalid('adapt.minHedges must be an integer from 1 to adapt.window');
  }
  if (!isNumber(resolved.lowWinRate) || resolved.lowWinRate < 0 || resolved.lowWinRate >= 1) {
    invalid('adapt.lowWinRate must be a number from 0 up to 1');
  }
  if (
    !isNumber(resolved.highWinRate) ||
    resolved.highWinRate <= resolved.lowWinRate ||
    resolved.highWinRate > 1
  ) {
    invalid('adapt.highWinRate must be a number above adapt.lowWinRate and at most 1');
  }
  if (
    !isNumber(resolved.quantileStep) ||
    resolved.quantileStep <= 0 ||
    resolved.quantileStep >= 1
  ) {
    invalid('adapt.quantileStep must be a number above 0 and below 1');
  }
  if (!isNumber(resolved.maxQuantile) || resolved.maxQuantile <= 0 || resolved.maxQuantile >= 1) {
    invalid('adapt.maxQuantile must be a number above 0 and below 1');
  }
  if (!isPositive(resolved.pauseMs)) {
    invalid('adapt.pauseMs must be a positive, finite number of milliseconds');
  }
  return resolved;
}
