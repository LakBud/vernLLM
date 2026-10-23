import { routerRouteKey } from '../../stateKeys.js';
import { hashUnit } from '../hash.utils.js';
import { routeMatches } from '../match/match.utils.js';

import type { ResolvedConfig, ResolvedRoute } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { RequestFacts } from '../match/requestFacts.utils.js';
import type { PreDispatchContext, WireCallRequest } from 'vern-llm';

/** The route that applies: the forced one if it exists, otherwise the first that matches. */
export function chooseRoute(
  config: ResolvedConfig,
  guard: Guard,
  ctx: PreDispatchContext,
  request: Readonly<WireCallRequest>,
  facts: RequestFacts,
): ResolvedRoute | undefined {
  const forced = ctx.state.get(routerRouteKey);
  if (forced !== undefined) {
    const route = config.routes.find((candidate) => candidate.name === forced);
    if (route) return route;
    // One stable key, so route names that vary per call cannot grow the warned set.
    guard.warnOnce('forced', `routerRouteKey names no route "${forced}"; matching instead`);
  }
  return config.routes.find((route) => routeMatches(route.when, ctx, request, facts));
}

/** The hash of the route's `stickyBy` context value, or nothing when the call lacks it. */
export function stickyUnitOf(route: ResolvedRoute, ctx: PreDispatchContext): number | undefined {
  if (route.strategy.type !== 'weighted' || route.strategy.stickyBy === undefined) return undefined;
  const value = ctx.context?.[route.strategy.stickyBy];
  if (value === undefined) return undefined;
  return hashUnit(typeof value === 'object' ? JSON.stringify(value) : String(value));
}
