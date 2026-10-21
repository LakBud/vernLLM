import {
  normalizeAttribute,
  normalizeBudgets,
  normalizeMaxSeries,
  normalizeTimeZone,
  normalizeOnStoreError,
  normalizeStore,
  normalizeWarnAt,
} from './budgetOptions.utils.js';
import { normalizePrices } from './normalizePrices.utils.js';
import {
  isPlainObject,
  optionalFunction,
  parsePricesAsOf,
  positiveNumber,
} from './validate.utils.js';

import type { ResolvedConfig, UsageMiddlewareOptions } from '../../types/index.js';

export const DEFAULT_MAX_PRICE_AGE_DAYS = 90;

export function normalizeOptions(options: UsageMiddlewareOptions): ResolvedConfig {
  // Checked as `unknown` so the guard does not narrow `options`.
  if (!isPlainObject(options as unknown)) {
    throw new Error('usageMiddleware: options must be an object');
  }

  const hasPrices = options.prices !== undefined;
  if (hasPrices === (options.priceFor !== undefined)) {
    throw new Error('usageMiddleware: pass exactly one of prices or priceFor');
  }

  optionalFunction(options.priceFor, 'priceFor');
  optionalFunction(options.normalizeModel, 'normalizeModel');

  if (hasPrices && options.pricesAsOf === undefined) {
    throw new Error('usageMiddleware: pricesAsOf is required with prices');
  }
  const pricesAsOfMs =
    options.pricesAsOf === undefined ? undefined : parsePricesAsOf(options.pricesAsOf);

  if (
    options.logger !== undefined &&
    options.logger !== 'silent' &&
    (typeof options.logger !== 'object' || options.logger === null)
  ) {
    throw new Error("usageMiddleware: logger must be a Logger or 'silent'");
  }

  const attribute = normalizeAttribute(options.attribute);

  return {
    attribute,
    budgets: normalizeBudgets(options.budgets, attribute),
    warnAt: normalizeWarnAt(options.warnAt),
    maxSeries: normalizeMaxSeries(options.maxSeries),
    timeZone: normalizeTimeZone(options.timeZone),
    onStoreError: normalizeOnStoreError(options.onStoreError),
    store: normalizeStore(options.store),
    prices: hasPrices ? normalizePrices(options.prices) : undefined,
    priceFor: options.priceFor,
    normalizeModel: options.normalizeModel,
    pricesAsOf: options.pricesAsOf,
    pricesAsOfMs,
    maxPriceAgeDays: positiveNumber(
      options.maxPriceAgeDays,
      'maxPriceAgeDays',
      DEFAULT_MAX_PRICE_AGE_DAYS,
    ),
    logger: options.logger,
  };
}
