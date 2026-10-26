import { createMiddlewareRef, type CallResult, type VernLLMMiddleware } from 'vern-llm';

import { createGuard } from './internal/guard.utils.js';
import { createCallFinisher } from './internal/middleware/callFinisher.utils.js';
import { createDecider } from './internal/middleware/createDecider.utils.js';
import { previewContext } from './internal/middleware/previewContext.utils.js';
import { normalizeOptions } from './internal/options/normalizeOptions.utils.js';
import { StatsCache } from './internal/statsCache.js';
import { TargetState } from './internal/targetState.js';
import { trackEvent } from './internal/trackEvent.utils.js';

import type { Decision, PreviewInput, RouterOptions } from './types/index.js';

/** One module level ref, so registering two instances hits the core's duplicate ref check. */
export const routerMiddlewareRef = createMiddlewareRef('router');

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

export function routerMiddleware(options: RouterOptions = {}): RouterMiddleware {
  const config = normalizeOptions(options);
  const guard = createGuard(config.logger);
  const state = new TargetState(config.slowStartMs);
  const stats = config.stats ? new StatsCache(config.stats, config.statsTtlMs) : undefined;
  const computeDecision = createDecider({ config, guard, state, stats });
  const { reorders, finish } = createCallFinisher(config, guard);

  return {
    name: 'router',
    ref: routerMiddlewareRef,

    preview: (input) => computeDecision(input.request, previewContext(config, input, Date.now())),

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
      guard('trackEvent', () => trackEvent(state, event, Date.now(), config.holdBack), undefined);
    },

    wrap: async (request, next, ctx) => {
      // Fail open: any problem deciding runs the call exactly as it would be without a router.
      const decision = guard('decide', () => computeDecision(request, ctx), undefined);
      if (!decision) return next();

      let result: CallResult | undefined;
      try {
        result = reorders(decision, ctx) ? await next({ targets: decision.order }) : await next();
        return result;
      } finally {
        finish(ctx, decision, result);
      }
    },
  };
}
