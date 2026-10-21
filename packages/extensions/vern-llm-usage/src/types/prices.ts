/**
 * One model's price, in dollars per 1M tokens. Unset cache and reasoning prices fall back to the
 * rate they are a subset of: `input` for cache reads and writes, `output` for reasoning.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  /** One rate for every write, or a rate per TTL label such as `'5m'` and `'1h'`. */
  cacheWrite?: number | Readonly<Record<string, number>>;
  reasoning?: number;
}

/**
 * Prices by model. A key is a model id, or `'<target>/<model>'` to price the same model differently
 * on two targets. The more specific key wins.
 */
export type ModelPrices = Readonly<Record<string, ModelPrice>>;

/**
 * Where a charge's price came from. `'reported'` is the cost the provider put in its response,
 * `'table'` is your price table times the token counts, and `'unpriced'` means tokens were counted
 * but no price matched. A call takes the weakest source among its charges.
 */
export type CostSource = 'reported' | 'table' | 'unpriced';
