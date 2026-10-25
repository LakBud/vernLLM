import { createMiddlewareRef } from 'vern-llm';

import { createEvaluate, createRedactText, createUpdate } from './internal/middleware/api.utils.js';
import { createLive } from './internal/middleware/live.js';
import { createTransform } from './internal/middleware/transform.utils.js';
import { createWrap } from './internal/middleware/wrap.utils.js';

import type { GuardMiddleware, GuardOptions } from './types/index.js';

/** One module level ref, so a second instance hits the core's duplicate ref check. */
export const guardMiddlewareRef = createMiddlewareRef('guard');

/**
 * Checks on what goes into a call and what comes out. A check can label the call for policy, redact
 * values and restore them in the answer, or block. It sits outside policy and usage, so a blocked
 * call spends nothing.
 */
export function guardMiddleware(options: GuardOptions): GuardMiddleware {
  // What a new call starts on. `update` swaps it; a call keeps the one it read.
  let live = createLive(options);
  const getLive = () => live;

  return {
    name: 'guard',
    ref: guardMiddlewareRef,
    position: -150,
    // After every other transform, so it sees what they added.
    priority: Number.MAX_SAFE_INTEGER,
    // Each detector has its own timeout, which never runs past the call's deadline.
    timeoutMs: 0,
    wrap: createWrap(getLive),
    transform: createTransform(getLive),
    evaluate: createEvaluate(getLive),
    update: createUpdate(getLive, (next) => {
      live = next;
    }),
    redactText: createRedactText(getLive),
  };
}
