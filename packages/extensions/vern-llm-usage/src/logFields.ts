import { createStateKey, type PreDispatchContext } from 'vern-llm';

import type { BudgetMode, CostSource } from './types/index.js';

/** What one call cost, for a log record to carry. */
export interface UsageLogFields {
  /** Everything the call spent, wasted attempts included. */
  estimatedCostUsd: number;
  /** The part spent on attempts whose response was then rejected. */
  wastedUsd: number;
  /** Absent when the call reported no usage at all, such as a cache hit. */
  costSource?: CostSource;
  /**
   * Only on a cache hit or join: an estimate of what it spared, by pricing the request and the
   * stored answer at the primary target. Absent when the primary has no price.
   */
  estimatedSavedUsd?: number;
  /** The highest share of any budget the call fell under, its own hold included. Absent without one. */
  budgetShare?: number;
}

/** How full one budget was when a call reserved against it. */
export interface BudgetShare {
  /** The context key the budget is on. */
  key: string;
  mode: BudgetMode;
  /** Spend plus holds over the limit: `0.93` is 93% used, and a soft budget can pass `1`. */
  share: number;
}

/** Which budgets `usageBudgetShare` considers. */
export interface BudgetShareOptions {
  /** Only budgets on this context key. */
  key?: string;
  /** Only hard or only soft budgets. */
  mode?: BudgetMode;
}

/**
 * Module level on purpose: the core rejects two usage instances on one `VernLLM`, so there is only
 * ever one writer, and `usageLogFields` can read it without being handed the instance.
 */
export const usageStateKey = createStateKey<UsageLogFields>('usage.fields');

/**
 * What the call cost, or `{}` when the call is not finished or was not metered. Call it with the
 * context a middleware receives, once the usage middleware's `next()` has returned:
 *
 * ```ts
 * const fields = usageLogFields(ctx);
 * ```
 *
 * The values travel in `ctx.state`, so a middleware that reads them does not need to import this
 * package's instance.
 */
export function usageLogFields(ctx: PreDispatchContext): Partial<UsageLogFields> {
  const fields = ctx.state.get(usageStateKey);
  return fields ? { ...fields } : {};
}

/**
 * The budgets a call fell under, set before `next()` so a middleware inside usage can read them.
 * Prefer `usageBudgetShare`.
 */
export const usageBudgetKey = createStateKey<readonly BudgetShare[]>('usage.budgetShare');

/**
 * The highest share of any budget this call falls under, this call's hold included: `0.93` means
 * 93% used. A soft budget can pass `1`. Readable from any middleware inside usage, or the app's own
 * `wrap`, before it calls `next()`.
 *
 * `undefined` when the call falls under no budget, or the store did not report figures: a custom
 * store without `used`, or a store error under `onStoreError: 'allow'`.
 *
 * The hold is priced at the most expensive target the call may use, so near a hard limit the share
 * can read higher than the call you end up making.
 */
export function usageBudgetShare(
  ctx: PreDispatchContext,
  options: BudgetShareOptions = {},
): number | undefined {
  const shares = ctx.state.get(usageBudgetKey);
  if (!shares) return undefined;

  let highest: number | undefined;
  for (const entry of shares) {
    if (options.key !== undefined && entry.key !== options.key) continue;
    if (options.mode !== undefined && entry.mode !== options.mode) continue;
    if (highest === undefined || entry.share > highest) highest = entry.share;
  }
  return highest;
}
