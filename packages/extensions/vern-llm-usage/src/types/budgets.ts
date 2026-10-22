/** A calendar window in UTC. Budgets reset at its boundary. */
export type BudgetWindow = 'hour' | 'day' | 'month';

/**
 * A spending limit for one context key. Without `equals` it applies to every value of the key
 * separately, so `{ key: 'tenantId', limitUsd: 50, per: 'day' }` gives each tenant $50 a day. With
 * `equals` it applies to that one value only. A call without the key is not limited by it.
 *
 * Set exactly one of `limitUsd` and `limitTokens`. `key` must also be listed in `attribute`.
 */
export interface UsageBudget {
  key: string;
  /** Limits one value of `key`, compared strictly. */
  equals?: string | number | boolean;
  /** At most about 9,000,000: money is held as integer nano dollars. */
  limitUsd?: number;
  /** Prompt plus completion tokens. */
  limitTokens?: number;
  per: BudgetWindow;
  /**
   * `'hard'` (the default) rejects a call that would go over the limit. `'soft'` never rejects: its
   * spend is tracked the same way and `usage.budget_exceeded` is emitted once per window when the
   * limit is first reached, with `blocked: false`. A soft and a hard budget can share a key, unit
   * and window, for an alert before a block.
   */
  mode?: BudgetMode;
}

/** Whether a budget rejects calls (`'hard'`) or only reports (`'soft'`). */
export type BudgetMode = 'hard' | 'soft';

/** What a call spends, as integers: nano dollars (1e-9 USD) and whole tokens. */
export interface Amount {
  nanoUsd: number;
  tokens: number;
}

/** One budget applied to one concrete value in one window, e.g. `tenantId=acme` on `2026-10-20`. */
export interface Scope {
  /** Identifies the budget, value and window, so a new window starts from zero. */
  key: string;
  /** For messages, e.g. `tenantId=acme per day`. */
  label: string;
  /** Which part of an `Amount` this scope limits. */
  unit: 'usd' | 'tokens';
  /** Nano dollars for `'usd'`, tokens for `'tokens'`. */
  limit: number;
  mode: BudgetMode;
  /** When the window ends, as epoch milliseconds. */
  resetsAtMs: number;
}
