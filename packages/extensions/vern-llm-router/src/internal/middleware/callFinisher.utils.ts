import { ROUTER_DECISION_EVENT } from '../../events.js';

import type { Decision, ResolvedConfig, RouterDecisionEvent } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { CallResult, JsonValue, PreDispatchContext } from 'vern-llm';

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/** What happens around the one `next()` call: whether to reorder, and reporting the decision. */
export function createCallFinisher(config: ResolvedConfig, guard: Guard) {
  return {
    /** Whether `next` should get the decided order: applying, not pinned, and actually different. */
    reorders(decision: Decision, ctx: PreDispatchContext): boolean {
      if (!config.apply || decision.strategy === 'pinned') return false;
      return !sameOrder(
        decision.order,
        ctx.targets.map((target) => target.name),
      );
    },

    /**
     * Reports the decision once `next()` has settled, so the event never sits ahead of the call,
     * and also after a throw. A cache hit or join never used the order, so it is not `applied`.
     */
    finish(ctx: PreDispatchContext, decision: Decision, result: CallResult | undefined): void {
      const applied = config.apply && decision.strategy !== 'pinned' && result?.cache === undefined;
      guard(
        'emit',
        () => {
          const event: RouterDecisionEvent = { v: 1, ...decision, applied };
          ctx.emit(ROUTER_DECISION_EVENT, event as unknown as JsonValue);
        },
        undefined,
      );
    },
  };
}
