import type { Guard } from '../guard.utils.js';
import type { PreDispatchContext } from 'vern-llm';

/**
 * The names `targets` returned that the call may actually use: strings the order contains, each
 * once. The core rejects an unknown or repeated name, which would spend a budget token on a chain
 * that fails at once.
 */
export function usableTargets(ctx: PreDispatchContext, names: unknown, guard: Guard): string[] {
  if (!Array.isArray(names)) {
    guard.warnOnce('targets-shape', 'targets must return an array of target names');
    return [];
  }

  const allowed = new Set(ctx.targets.map((target) => target.name));
  return [...new Set(names.filter((name): name is string => allowed.has(name)))];
}
