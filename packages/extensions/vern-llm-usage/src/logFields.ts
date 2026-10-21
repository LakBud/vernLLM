import { createStateKey, type PreDispatchContext } from 'vern-llm';

import type { CostSource } from './types/index.js';

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
