import { LLMError } from '../../types/errors.js';

import type { TargetInfo } from '../../types/fallback.js';
import type { CallExecutor } from './callExecutor.js';

/** One configured target, with the declared position that stays its identity in events and meta. */
export interface ResolvedTarget {
  executor: CallExecutor;
  /** Declared index: 0 is the primary. Unchanged by any reordering. */
  index: number;
}

/** Every target in declared order. */
export function declaredTargets(executors: readonly CallExecutor[]): ResolvedTarget[] {
  return executors.map((executor, index) => ({ executor, index }));
}

/**
 * The targets as `ctx.targets` shows them. `model` is what the target would run, so the per call
 * `model` override shows on the primary only.
 */
export function describeTargets(
  targets: readonly ResolvedTarget[],
  modelFor: (index: number) => string | undefined,
): TargetInfo[] {
  return targets.map(({ executor, index }) => ({
    name: executor.providerName,
    index,
    model: modelFor(index) ?? executor.model,
    adapter: executor.adapter,
  }));
}

function noEligibleTargets(message: string): LLMError {
  return new LLMError(message, 'invalid_params', { code: 'no_eligible_targets' });
}

/**
 * Applies `requested` on top of `current`, both by target name. Names in `all` but outside
 * `current` were removed by an outer layer, so they are dropped and reported through `onDropped`
 * rather than added back. Throws `invalid_params` before any provider is contacted:
 * `unknown_target` for a name in no target, `no_eligible_targets` for an empty or repeating list
 * or one that ends up empty.
 */
export function narrowTargets(
  all: readonly ResolvedTarget[],
  current: readonly ResolvedTarget[],
  requested: readonly string[] | undefined,
  onDropped: (name: string) => void,
): ResolvedTarget[] {
  if (requested === undefined) return [...current];

  // Only a caller bypassing the types gets here, so this carries no `code`.
  if (!Array.isArray(requested) || requested.some((name) => typeof name !== 'string')) {
    throw new LLMError('`targets` must be an array of target names', 'invalid_params');
  }

  if (requested.length === 0 || new Set(requested).size !== requested.length) {
    throw noEligibleTargets('`targets` must name at least one target, each at most once');
  }

  const narrowed: ResolvedTarget[] = [];

  for (const name of requested) {
    if (!all.some((target) => target.executor.providerName === name)) {
      const valid = all.map((target) => `"${target.executor.providerName}"`).join(', ');
      throw new LLMError(`Unknown target "${name}". Valid targets: ${valid}`, 'invalid_params', {
        code: 'unknown_target',
      });
    }

    const allowed = current.find((target) => target.executor.providerName === name);

    if (allowed) narrowed.push(allowed);
    else onDropped(name);
  }

  if (narrowed.length === 0) {
    throw noEligibleTargets(
      'No target is left: every requested target was removed by an outer layer',
    );
  }

  return narrowed;
}
