import { toResolvedPrice } from '../options/normalizePrices.utils.js';

import type { ResolvedConfig, ResolvedPrice } from '../../types/index.js';

/**
 * Finds a model's price: `priceFor` alone, else `'<provider>/<model>'` then `'<model>'`. No prefix
 * matching.
 */
export class PriceTable {
  /** A `priceFor` result converted once per object. */
  private readonly converted = new WeakMap<object, ResolvedPrice>();

  constructor(
    private readonly config: Pick<ResolvedConfig, 'prices' | 'priceFor' | 'normalizeModel'>,
  ) {}

  /** Throws when `normalizeModel`, `priceFor` or the returned price is invalid. */
  lookup(model: string, provider: string | undefined): ResolvedPrice | undefined {
    const { prices, priceFor, normalizeModel } = this.config;

    if (priceFor) {
      const price = priceFor(model, provider ?? 'primary');
      return price === undefined ? undefined : this.convert(price);
    }

    const key = normalizeModel ? normalizeModel(model) : model;
    return (
      (provider === undefined ? undefined : prices?.get(`${provider}/${key}`)) ?? prices?.get(key)
    );
  }

  private convert(price: object): ResolvedPrice {
    const known = this.converted.get(price);
    if (known) return known;

    const resolved = toResolvedPrice(price, 'priceFor result');
    this.converted.set(price, resolved);
    return resolved;
  }
}
