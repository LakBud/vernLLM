import { HEDGE_DECISION_EVENT } from '../../events.js';
import { hedgeDecisionKey } from '../../stateKeys.js';

import type { HedgeDecisionEvent } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { JsonValue, PreDispatchContext } from 'vern-llm';

/** What a decision carries besides `v`, so the call site names only what it knows. */
export type Decision = Omit<HedgeDecisionEvent, 'v'>;

/** The hedge count for the event, only when it is more than one. */
export const hedgesOf = (sent: number): Pick<Decision, 'hedges'> =>
  sent > 1 ? { hedges: sent } : {};

/** Writes the decision where the log fields and the logger read it, once, and never throws. */
export function record(ctx: PreDispatchContext, guard: Guard, decision: Decision): void {
  const event: HedgeDecisionEvent = {
    v: 1,
    outcome: decision.outcome,
    ...(decision.delayMs !== undefined && { delayMs: Math.round(decision.delayMs) }),
    ...(decision.target !== undefined && { target: decision.target }),
    ...(decision.hedges !== undefined && { hedges: decision.hedges }),
    ...(decision.winner !== undefined && { winner: decision.winner }),
    ...(decision.ms !== undefined && { ms: Math.round(decision.ms) }),
  };

  guard('state', () => ctx.state.set(hedgeDecisionKey, event), undefined);
  guard('emit', () => ctx.emit(HEDGE_DECISION_EVENT, event as unknown as JsonValue), undefined);
}
