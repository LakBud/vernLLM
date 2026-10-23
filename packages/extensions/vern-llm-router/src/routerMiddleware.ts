import {
  createMiddlewareRef,
  createMiddlewareStateBag,
  stateEntry,
  type CallResult,
  type JsonValue,
  type PreDispatchContext,
  type VernLLMMiddleware,
  type WireCallRequest,
} from 'vern-llm';

import { decide, pinnedDecision, unknownTargetsOf } from './internal/decide/decide.js';
import { gather } from './internal/gather.utils.js';
import { createGuard, type Guard } from './internal/guard.utils.js';
import { hashUnit } from './internal/hash.utils.js';
import { routeMatches } from './internal/match/match.utils.js';
import { createRequestFacts } from './internal/match/requestFacts.utils.js';
import { normalizeOptions } from './internal/options/normalizeOptions.utils.js';
import { StatsCache } from './internal/statsCache.js';
import { TargetState } from './internal/targetState.js';
import { trackEvent } from './internal/trackEvent.utils.js';
import { routerRouteKey } from './stateKeys.js';

import type {
  Decision,
  PreviewInput,
  ResolvedConfig,
  ResolvedRoute,
  RouterDecisionEvent,
  RouterOptions,
} from './types/index.js';

/** One module level ref, so registering two instances hits the core's duplicate ref check. */
export const routerMiddlewareRef = createMiddlewareRef('router');

/** Name of the custom event carrying each call's decision. */
export const ROUTER_DECISION_EVENT = 'router.decision';

/** The middleware to register, and a dry run of its decision. */
export interface RouterMiddleware extends VernLLMMiddleware {
  /**
   * The decision a call would get right now, without calling anything: the same function a call
   * uses, with the same live signals. For tests, debugging a route, and answering "where would
   * this tenant's calls go?". Needs `health`, which is how it learns the targets. It draws from
   * the same random source, so set `random` for a repeatable answer.
   *
   * @throws If `health` is not set or returns nothing, or `targets` names an unknown target.
   */
  preview(input: PreviewInput): Decision;
}

/** The route that applies: the forced one if it exists, otherwise the first that matches. */
function chooseRoute(
  config: ResolvedConfig,
  guard: Guard,
  ctx: PreDispatchContext,
  request: Readonly<WireCallRequest>,
  facts: ReturnType<typeof createRequestFacts>,
): ResolvedRoute | undefined {
  const forced = ctx.state.get(routerRouteKey);
  if (forced !== undefined) {
    const route = config.routes.find((candidate) => candidate.name === forced);
    if (route) return route;
    guard.warnOnce(
      `forced:${forced}`,
      `routerRouteKey names no route "${forced}"; matching instead`,
    );
  }
  return config.routes.find((route) => routeMatches(route.when, ctx, request, facts));
}

/** The hash of the route's `stickyBy` context value, or nothing when the call lacks it. */
function stickyUnitOf(route: ResolvedRoute, ctx: PreDispatchContext): number | undefined {
  if (route.strategy.type !== 'weighted' || route.strategy.stickyBy === undefined) return undefined;
  const value = ctx.context?.[route.strategy.stickyBy];
  if (value === undefined) return undefined;
  return hashUnit(typeof value === 'object' ? JSON.stringify(value) : String(value));
}

function computeDecision(
  config: ResolvedConfig,
  guard: Guard,
  state: TargetState,
  stats: StatsCache | undefined,
  request: Readonly<WireCallRequest>,
  ctx: PreDispatchContext,
): Decision {
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
  return decide({
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
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/** A context for a call that has not been made, built from the instance's own targets. */
function previewContext(
  config: ResolvedConfig,
  input: PreviewInput,
  now: number,
): PreDispatchContext {
  if (!config.health) {
    throw new Error('routerMiddleware: preview needs the health option to know the targets');
  }
  const source = config.health();
  if (!source) {
    throw new Error('routerMiddleware: preview needs health to return the VernLLM instance');
  }

  const adapter = { name: 'custom' };
  const declared = source.getCircuitStates().map((entry) => ({
    name: entry.provider,
    index: entry.index,
    model: input.request.model,
    adapter,
  }));
  const targets = input.targets
    ? input.targets.map((name) => {
        const found = declared.find((target) => target.name === name);
        if (!found) throw new Error(`routerMiddleware: preview names no target "${name}"`);
        return found;
      })
    : declared;

  return {
    stage: 'pre-dispatch',
    requestId: 'preview',
    capabilities: {},
    state: createMiddlewareStateBag(
      input.route === undefined ? [] : [stateEntry(routerRouteKey, input.route)],
    ),
    emit: () => undefined,
    context: input.context,
    streaming: input.streaming === true,
    callTargets: input.targets,
    deadlineAt: input.deadlineMs === undefined ? undefined : now + input.deadlineMs,
    targets,
  } as unknown as PreDispatchContext;
}

export function routerMiddleware(options: RouterOptions = {}): RouterMiddleware {
  const config = normalizeOptions(options);
  const guard = createGuard(config.logger);
  const state = new TargetState(config.slowStartMs);
  const stats = config.stats ? new StatsCache(config.stats, config.statsTtlMs) : undefined;

  return {
    name: 'router',
    ref: routerMiddlewareRef,

    preview: (input) =>
      computeDecision(
        config,
        guard,
        state,
        stats,
        input.request,
        previewContext(config, input, Date.now()),
      ),

    // Inside the logger and usage, so both see the net result of the order chosen here.
    position: 0,

    // Counts attempts in flight per target. Always calls next() once and rethrows its exact error.
    dispatch: async (_request, next, ctx) => {
      guard('attemptStarted', () => state.attemptStarted(ctx.requestedProvider), undefined);
      try {
        await next();
      } finally {
        guard(
          'attemptEnded',
          () => state.attemptEnded(ctx.requestedProvider, Date.now()),
          undefined,
        );
      }
    },

    // Static, with no `enabled`, so events arrive in order. Also sees breaker changes made
    // outside any call, such as a shared breaker another process opened.
    onEvent: (event) => {
      guard('trackEvent', () => trackEvent(state, event), undefined);
    },

    wrap: async (request, next, ctx) => {
      // Fail open: any problem deciding runs the call exactly as it would be without a router.
      const decision = guard(
        'decide',
        () => computeDecision(config, guard, state, stats, request, ctx),
        undefined,
      );
      if (!decision) return next();

      const current = ctx.targets.map((target) => target.name);
      const reorder =
        config.apply && decision.strategy !== 'pinned' && !sameOrder(decision.order, current);

      let result: CallResult | undefined;
      try {
        result = reorder ? await next({ targets: decision.order }) : await next();
        return result;
      } finally {
        // Reported after `next()` so the event never sits ahead of the call, and also on a throw.
        const applied =
          config.apply && decision.strategy !== 'pinned' && result?.cache === undefined;
        guard(
          'emit',
          () => {
            const event: RouterDecisionEvent = { v: 1, ...decision, applied };
            ctx.emit(ROUTER_DECISION_EVENT, event as unknown as JsonValue);
          },
          undefined,
        );
      }
    },
  };
}
