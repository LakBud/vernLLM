import { finiteNonNegative, isPlainObject } from './validate.utils.js';

import type { ModelPrice, ResolvedPrice } from '../../types/index.js';

/** $ per 1M tokens to nano dollars per token: $1 per 1M is 1000. */
const NANO_PER_TOKEN_PER_DOLLAR_PER_MILLION = 1000;

function toNano(dollarsPerMillion: number): number {
  return Math.round(dollarsPerMillion * NANO_PER_TOKEN_PER_DOLLAR_PER_MILLION);
}

/**
 * Validates a price and converts it to integer nano dollars per token. Finer than $0.001 per 1M
 * rounds.
 */
export function toResolvedPrice(price: unknown, label: string): ResolvedPrice {
  if (!isPlainObject(price)) throw new Error(`usageMiddleware: ${label} must be an object`);

  const input = toNano(finiteNonNegative(price.input, `${label}.input`));
  const output = toNano(finiteNonNegative(price.output, `${label}.output`));
  const optional = (value: unknown, name: string, fallback: number): number =>
    value === undefined ? fallback : toNano(finiteNonNegative(value, `${label}.${name}`));

  const cacheWrite = (price as Partial<ModelPrice>).cacheWrite;
  const byTtl = new Map<string, number>();
  let flatWrite = input;

  if (isPlainObject(cacheWrite)) {
    for (const [ttl, rate] of Object.entries(cacheWrite)) {
      if (ttl === '') {
        throw new Error(`usageMiddleware: ${label}.cacheWrite keys must be non-empty strings`);
      }
      byTtl.set(ttl, toNano(finiteNonNegative(rate, `${label}.cacheWrite.${ttl}`)));
    }
  } else if (cacheWrite !== undefined) {
    flatWrite = toNano(finiteNonNegative(cacheWrite, `${label}.cacheWrite`));
  }

  return {
    input,
    output,
    cacheRead: optional(price.cacheRead, 'cacheRead', input),
    cacheWrite: flatWrite,
    cacheWriteByTtl: byTtl,
    reasoning: optional(price.reasoning, 'reasoning', output),
  };
}

/** Validates a whole table. Errors name the model key, e.g. `prices["gpt-6"].input`. */
export function normalizePrices(prices: unknown): Map<string, ResolvedPrice> {
  if (!isPlainObject(prices)) throw new Error('usageMiddleware: prices must be an object');

  const resolved = new Map<string, ResolvedPrice>();
  for (const [model, price] of Object.entries(prices)) {
    resolved.set(model, toResolvedPrice(price, `prices["${model}"]`));
  }
  return resolved;
}
