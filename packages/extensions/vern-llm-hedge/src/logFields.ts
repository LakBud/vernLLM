import { hedgeDecisionKey } from './stateKeys.js';

import type { JsonValue, MiddlewareStateBag } from 'vern-llm';

/** The part of a context the reader needs, so any hook's `ctx` fits. */
interface WithState {
  state: MiddlewareStateBag;
}

/**
 * Fields for a log record: `hedge` (the outcome) and `hedge_delay_ms` when a delay was computed,
 * such as `{ hedge: 'won', hedge_delay_ms: 840 }` or `{ hedge: 'budget' }`. `undefined` when the
 * hedge did not run. Pass it to the logger's `enrich` option.
 */
export function hedgeLogFields(ctx: WithState): Record<string, JsonValue> | undefined {
  const decision = ctx.state.get(hedgeDecisionKey);
  if (decision === undefined) return undefined;

  return {
    hedge: decision.outcome,
    ...(decision.delayMs !== undefined && { hedge_delay_ms: decision.delayMs }),
  };
}
