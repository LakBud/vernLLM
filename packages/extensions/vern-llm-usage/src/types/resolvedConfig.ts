import type { BudgetMode, BudgetWindow } from './budgets.js';
import type { LoggerOption } from './options.js';
import type { ModelPrice } from './prices.js';
import type { UsageStore } from './store.js';

/** A price in integer nano dollars (1e-9 USD) per token, so sums never drift. */
export interface ResolvedPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** The rate for writes without a TTL rate of their own. */
  cacheWrite: number;
  cacheWriteByTtl: ReadonlyMap<string, number>;
  reasoning: number;
}

/** A budget with its limit in the unit it is counted in. */
export interface ResolvedBudget {
  key: string;
  equals: string | number | boolean | undefined;
  unit: 'usd' | 'tokens';
  /** Nano dollars for `'usd'`, tokens for `'tokens'`. */
  limit: number;
  per: BudgetWindow;
  mode: BudgetMode;
}

/** Options after validation, with every default filled in. */
export interface ResolvedConfig {
  prices: ReadonlyMap<string, ResolvedPrice> | undefined;
  priceFor: ((model: string, provider: string) => ModelPrice | undefined) | undefined;
  normalizeModel: ((model: string) => string) | undefined;
  pricesAsOf: string | undefined;
  /** `pricesAsOf` as epoch milliseconds, UTC. */
  pricesAsOfMs: number | undefined;
  maxPriceAgeDays: number;
  attribute: readonly string[];
  budgets: readonly ResolvedBudget[];
  warnAt: readonly number[];
  maxSeries: number;
  timeZone: string;
  onStoreError: 'allow' | 'deny';
  store: UsageStore | undefined;
  logger: LoggerOption | undefined;
}
