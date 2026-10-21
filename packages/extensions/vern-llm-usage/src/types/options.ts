import type { UsageBudget } from './budgets.js';
import type { ModelPrice, ModelPrices } from './prices.js';
import type { UsageStore } from './store.js';
import type { Logger } from 'vern-llm';

/** Same shape as `VernLLMOptions.logger`. */
export type LoggerOption = Logger | 'silent';

/** Pass exactly one of `prices` or `priceFor`. */
export interface UsageMiddlewareOptions {
  /** Prices by model, in dollars per 1M tokens. Requires `pricesAsOf`. */
  prices?: ModelPrices;

  /**
   * Looks a price up per call instead of a fixed table. `provider` is the target name. Return
   * `undefined` for an unknown model. A throw is logged and the call is counted as unpriced.
   */
  priceFor?: (model: string, provider: string) => ModelPrice | undefined;

  /** The date `prices` was last checked, `YYYY-MM-DD`. Required with `prices`. */
  pricesAsOf?: string;

  /** Logs one warning when `pricesAsOf` is older than this. Defaults to 90. */
  maxPriceAgeDays?: number;

  /** Maps a model id to its table key before a `prices` lookup, e.g. to drop a date suffix. */
  normalizeModel?: (model: string) => string;

  /** The `context` keys spend is attributed to. A budget's `key` must be one of them. */
  attribute?: readonly string[];

  /**
   * Limits checked before a call is sent. A call that would go over one is rejected with
   * `LLMError` type `quota_exceeded`, code `budget_exceeded`, and no provider is contacted.
   */
  budgets?: readonly UsageBudget[];

  /**
   * Emits `usage.budget_warning` once per budget and window when spend and holds reach this share
   * of the limit. A number between 0 and 1, exclusive. Off when absent.
   */
  warnAt?: number;

  /**
   * The IANA time zone budget windows and `totals` follow, such as `'America/New_York'`. Hour, day
   * and month windows start on that zone's clock, daylight saving included. Defaults to `'UTC'`.
   */
  timeZone?: string;

  /** Most series `totals` keeps per window. Past it new ones go to `__other__`. Defaults to 1,000. */
  maxSeries?: number;

  /**
   * What to do when the store fails while reserving: `'allow'` sends the call unmetered and logs
   * it, `'deny'` rejects it like an exceeded budget. Defaults to `'allow'`.
   */
  onStoreError?: 'allow' | 'deny';

  /** Where budget spend lives. Defaults to `memoryUsageStore()`, which is per process. */
  store?: UsageStore;

  /** This package's own diagnostics. Defaults to the console. */
  logger?: LoggerOption;
}
