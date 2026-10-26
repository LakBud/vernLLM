import { usableTargets } from './usableTargets.utils.js';

import type { SkipReason } from '../../types/index.js';
import type { HedgeDeps } from './deps.js';
import type { PreDispatchContext, WireCallRequest } from 'vern-llm';

/** Whether to run the call as it is, and why, or to race it. */
export type Plan =
  | { kind: 'skip'; outcome: SkipReason; delayMs?: number }
  | { kind: 'hedge'; targets: string[]; first: string; delayMs: number };

/**
 * Decides before anything is sent whether a call may be hedged, and how long to wait. The order
 * of the checks is the order of the outcomes: the first one that says no is reported.
 */
export function plan(
  { config, guard, adapt, cacheAware, delay, prefixKey }: HedgeDeps,
  request: Readonly<WireCallRequest>,
  ctx: PreDispatchContext,
  hasAgain: boolean,
  callStart: number,
): Plan {
  if (!hasAgain) return { kind: 'skip', outcome: 'unavailable' };

  const targets = guard(
    'targets',
    () => usableTargets(ctx, config.targets(ctx, request), guard),
    [],
  );
  if (targets.length === 0) return { kind: 'skip', outcome: 'no_target' };

  if (!guard('when', () => Boolean(config.when(ctx)), false)) {
    return { kind: 'skip', outcome: 'not_allowed' };
  }

  // The first target is the one the call is sent to, and the one whose hedges are counted.
  const first = ctx.targets[0]!.name;
  if (adapt?.paused(first, callStart)) return { kind: 'skip', outcome: 'paused' };

  // A target holding this prefix in its cache answers cheaply and soon; a hedge elsewhere would
  // start cold. The prefix is kept for the usage events of this call.
  let warm = false;
  if (cacheAware) {
    const key = guard('cacheKey', () => cacheAware.keyOf(request), undefined);
    if (key !== undefined) {
      guard('cacheState', () => ctx.state.set(prefixKey, key), undefined);
      warm = cacheAware.warm(first, key, callStart);
    }
  }
  if (warm && config.cacheAware!.action === 'skip') return { kind: 'skip', outcome: 'cached' };

  const learned = guard('delay', () => delay.for(ctx, request), undefined);
  if (learned === undefined) return { kind: 'skip', outcome: 'no_data' };
  const delayMs = warm ? learned * config.cacheAware!.delayFactor : learned;

  if (ctx.deadlineAt !== undefined && callStart + delayMs >= ctx.deadlineAt) {
    return { kind: 'skip', outcome: 'deadline', delayMs };
  }

  return { kind: 'hedge', targets, first, delayMs };
}
