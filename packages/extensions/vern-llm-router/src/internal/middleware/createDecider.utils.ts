import { decide, pinnedDecision, unknownTargetsOf } from '../decide/decide.js';
import { gather } from '../gather.utils.js';
import { createRequestFacts } from '../match/requestFacts.utils.js';
import { chooseRoute, stickyUnitOf } from './chooseRoute.utils.js';

import type { Decision, ResolvedConfig } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { StatsCache } from '../statsCache.js';
import type { TargetState } from '../targetState.js';
import type { PreDispatchContext, WireCallRequest } from 'vern-llm';

export interface DeciderDeps {
  config: ResolvedConfig;
  guard: Guard;
  state: TargetState;
  stats: StatsCache | undefined;
}

/**
 * The one function a call and a preview both use: pick the route, read the signals, decide.
 * Synchronous, so nothing here can add a wait before the call starts.
 */
export function createDecider({ config, guard, state, stats }: DeciderDeps) {
  return (request: Readonly<WireCallRequest>, ctx: PreDispatchContext): Decision => {
    const names = ctx.targets.map((target) => target.name);
    // A caller who passed `targets` chose the order; the router only records it.
    if (ctx.callTargets !== undefined) return pinnedDecision(names);

    const facts = createRequestFacts(request);
    const route = chooseRoute(config, guard, ctx, request, facts);
    if (route) {
      for (const name of unknownTargetsOf(route, names)) {
        guard.warnOnce(
          `unknown:${route.name}:${name}`,
          `route "${route.name}" names "${name}", which is not a target of this call`,
        );
      }
    }
    const now = Date.now();
    const signals = gather({
      targets: ctx.targets,
      route,
      request,
      context: ctx.context,
      streaming: ctx.streaming === true,
      deadlineAt: ctx.deadlineAt,
      health: config.health,
      stats,
      cost: config.cost,
      state,
      facts,
      guard,
      now,
    });
    const decision = decide({
      targets: names,
      route,
      capabilities: config.capabilities,
      facts,
      signals,
      rng: config.random,
      stickyUnit: route ? stickyUnitOf(route, ctx) : undefined,
      now,
      deadlineAt: ctx.deadlineAt,
    });
    if (route && decision.order.length === 0) {
      guard.warnOnce(
        `empty:${route.name}`,
        `route "${route.name}" leaves no target for this call; the call will fail with no_eligible_targets`,
      );
    }
    return decision;
  };
}
