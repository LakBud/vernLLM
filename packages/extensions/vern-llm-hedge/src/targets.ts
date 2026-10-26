import type { PreDispatchContext } from 'vern-llm';

/**
 * The call's targets after the first, in order: where a hedge goes by default. Inside the router
 * that is the router's second choice, already narrowed by policy. The rest of the order stays
 * behind it, so the hedge has its own fallback.
 */
export function nextTargets(ctx: Pick<PreDispatchContext, 'targets'>): readonly string[] {
  return ctx.targets.slice(1).map((target) => target.name);
}
