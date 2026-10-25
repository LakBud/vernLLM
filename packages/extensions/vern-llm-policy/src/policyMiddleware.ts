import { createMiddlewareRef } from 'vern-llm';

import { createEvaluate, createUpdate } from './internal/middleware/api.utils.js';
import { createLive } from './internal/middleware/live.js';
import { createWrap } from './internal/middleware/wrap.utils.js';
import { compile } from './internal/options/compile.utils.js';

import type { PolicyMiddleware, PolicyOptions } from './types/index.js';

/** One module level ref, so a second instance hits the core's duplicate ref check. */
export const policyMiddlewareRef = createMiddlewareRef('policy');

/**
 * Rules that decide which targets a call may use, and whether it may run at all. It sits outside
 * usage and the router, so a denied call spends nothing.
 */
export function policyMiddleware(options: PolicyOptions = {}): PolicyMiddleware {
  let live = createLive(compile(options), options.logger);
  const getLive = () => live;

  return {
    name: 'policy',
    ref: policyMiddlewareRef,
    position: -100,
    // Nothing before `next()` waits.
    wrap: createWrap(getLive),
    evaluate: createEvaluate(getLive),
    update: createUpdate(options.logger, (next) => {
      live = next;
    }),
  };
}
