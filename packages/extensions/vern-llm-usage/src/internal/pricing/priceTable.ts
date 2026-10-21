import { toResolvedPrice } from '../options/normalizePrices.utils.js';

import type { ResolvedConfig, ResolvedPrice } from '../../types/index.js';

/**
 * Finds the price for a model. Immutable after construction.
 *
 * With `priceFor` it asks that function and nothing else. With a table it tries
 * `'<provider>/<model>'` and then `'<model>'`, after `normalizeModel`. There is no prefix matching:
 * `gpt-6` silently pricing `gpt-6-mini` would be worse than an unpriced warning.
 */
export class PriceTable {
  /** A `priceFor` result converted once per returned object, so a stable table costs nothing. */
  private readonly converted = new WeakMap<object, ResolvedPrice>();

  constructor(
    private readonly config: Pick<ResolvedConfig, 'prices' | 'priceFor' | 'normalizeModel'>,
  ) {}

  /** Throws when `normalizeModel` or `priceFor` throws, or `priceFor` returns an invalid price. */
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
