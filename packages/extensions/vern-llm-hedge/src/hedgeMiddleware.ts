import { createMiddlewareRef, createStateKey, type VernLLMMiddleware } from 'vern-llm';

import { Adapt } from './internal/adapt.js';
import { HedgeBudget } from './internal/budget.js';
import { CacheAware } from './internal/cacheAware.js';
import { createDelay } from './internal/delay/delay.utils.js';
import { createGuard } from './internal/guard.utils.js';
import { createCacheEvent } from './internal/middleware/cacheEvent.utils.js';
import { createWrap } from './internal/middleware/wrap.utils.js';
import { normalizeOptions } from './internal/options/normalizeOptions.utils.js';

import type { HedgeDeps } from './internal/middleware/deps.js';
import type { HedgeOptions } from './types/index.js';

/** One module level ref, so registering two instances hits the core's duplicate ref check. */
export const hedgeMiddlewareRef = createMiddlewareRef('hedge');

/**
 * When a call's first answer is slower than that target usually is, sends the same call to the
 * next target too, keeps whichever answers first, and lets the core cancel the other.
 */
export function hedgeMiddleware(options: HedgeOptions = {}): VernLLMMiddleware {
  const config = normalizeOptions(options);
  const guard = createGuard(config.logger);
  const adapt = config.adapt
    ? new Adapt(config.adapt, config.delay.kind === 'quantile' ? config.delay.quantile : undefined)
    : undefined;

  const deps: HedgeDeps = {
    config,
    guard,
    budget: new HedgeBudget(config.budget.ratio, config.budget.burst),
    adapt,
    cacheAware: config.cacheAware ? new CacheAware(config.cacheAware) : undefined,
    delay: createDelay(config, guard, adapt),
    prefixKey: createStateKey<string>('hedge.prefix'),
  };
  const onEvent = createCacheEvent(deps);

  return {
    name: 'hedge',
    ref: hedgeMiddlewareRef,

    // Inside the logger, guard, policy, usage and router, which should see one call, and outside
    // the attempts it races.
    position: 10,

    // Gives `wrap` `next.again()`, and has the core cancel the chain that is not returned.
    reruns: true,

    // A target that reports cache reads has this call's prefix in its cache for a while.
    ...(onEvent && { onEvent }),

    wrap: createWrap(deps),
  };
}
