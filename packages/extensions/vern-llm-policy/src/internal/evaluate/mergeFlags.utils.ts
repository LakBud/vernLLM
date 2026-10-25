import { NO_FLAGS, NO_REMOVALS } from './empty.js';
import { compare } from './sort.utils.js';

import type { Decision } from '../../types/decision.js';
import type { AppliedRule } from './applyRule.utils.js';

/** Flags of the applied enforced rules, `false` winning, with the smallest id that set each. */
export function mergeFlags(
  enforced: readonly AppliedRule[],
): Pick<Decision, 'flags' | 'flagCauses'> {
  const sets = enforced.flatMap(({ id, flags = {} }) =>
    Object.entries(flags).map(([name, value]) => ({ name, value, id })),
  );
  const names = [...new Set(sets.map((set) => set.name))].sort(compare);
  if (names.length === 0) return { flags: NO_FLAGS, flagCauses: NO_REMOVALS };

  const causes = names.map(
    (name) =>
      sets
        .filter((set) => set.name === name && !set.value)
        .map((set) => set.id)
        .sort(compare)[0],
  );
  return {
    flags: Object.freeze(
      Object.fromEntries(names.map((name, i) => [name, causes[i] === undefined])),
    ),
    flagCauses: Object.freeze(
      Object.fromEntries(
        names.flatMap((name, i) => (causes[i] === undefined ? [] : [[name, causes[i]]])),
      ),
    ),
  };
}
