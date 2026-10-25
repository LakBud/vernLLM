import { POLICY_CROSS_JOIN_EVENT, POLICY_DECISION_EVENT } from '../../events.js';
import { policyFlagsKey } from '../../flags.js';
import { decideCall, joinedRemoved, warnRuleErrors } from './decideCall.utils.js';
import { policyDenied, policyFailed } from './deny.utils.js';
import { crossJoinEvent, decisionEvent } from './event.utils.js';
import { checkDeclaredNames, type Live } from './live.js';

import type { Decision, PolicyMiddleware } from '../../types/index.js';
import type { JsonValue, PreDispatchContext } from 'vern-llm';

type Wrap = NonNullable<PolicyMiddleware['wrap']>;

/** Emits what happened to a call that was narrowed and answered by a joined `cachedCall`. */
function reportJoin(
  live: Live,
  ctx: PreDispatchContext,
  result: Parameters<typeof joinedRemoved>[0],
  decision: Decision,
): void {
  const joined = joinedRemoved(result, decision);
  if (joined === undefined) return;

  ctx.emit(
    POLICY_CROSS_JOIN_EVENT,
    crossJoinEvent(live.policy.version, joined.target, joined.rule) as unknown as JsonValue,
  );
  live.guard.warnOnce(
    `cross_join:${joined.rule}`,
    `a call joined another caller's cachedCall and was answered by "${joined.target}", which rule "${joined.rule}" removed for it. Put whatever the rules differ on in the cacheKey`,
  );
}

/** The `wrap` hook. It reads the live policy once per call, so an `update` waits for the next. */
export function createWrap(getLive: () => Live): Wrap {
  return async (request, next, ctx) => {
    const live = getLive();
    const { policy } = live;

    checkDeclaredNames(live, ctx.targets);
    const now = Date.now();
    live.warnExpired(now);

    const { decision, failed } = decideCall(live, request, ctx, now);
    warnRuleErrors(live, decision);

    // Before `next()`, so anything inside can read them.
    if (Object.keys(decision.flags).length > 0) ctx.state.set(policyFlagsKey, decision.flags);
    // Before `next()`, so the record exists even if the call fails or never goes on.
    ctx.emit(POLICY_DECISION_EVENT, decisionEvent(decision) as unknown as JsonValue);

    if (failed) {
      // Fail closed by default. `onError: 'open'` runs the call untouched.
      if (policy.onError === 'open') return next();
      throw policyFailed(policy.version);
    }
    if (decision.outcome === 'denied') throw policyDenied(decision);
    if (decision.outcome === 'allowed') return next();

    // Removal is final inside, except for a `cachedCall` join, which shares someone else's call.
    const result = await next({ targets: decision.allowed });
    reportJoin(live, ctx, result, decision);
    return result;
  };
}
