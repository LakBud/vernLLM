import { createGuard, type Guard } from '../guard.utils.js';

import type { PolicyOptions } from '../../types/index.js';
import type { CompiledPolicy } from '../../types/resolvedConfig.js';
import type { PreDispatchContext } from 'vern-llm';

/** A compiled policy with its own warning state. A call reads one `Live` from start to end. */
export interface Live {
  readonly policy: CompiledPolicy;
  readonly guard: Guard;
  readonly warnExpired: (now: number) => void;
  /** Whether declared target names were compared with a real call yet. */
  namesChecked: boolean;
}

export function createLive(policy: CompiledPolicy, logger: PolicyOptions['logger']): Live {
  const guard = createGuard(logger);

  // An exception that ended is ignored, and said so once.
  const expiring = policy.rules.flatMap((rule) =>
    rule.except.map((exception, index) => ({ rule: rule.id, index, exception })),
  );
  const warnExpired = (now: number): void => {
    for (const { rule, index, exception } of expiring) {
      if (exception.end <= now) {
        guard.warnOnce(
          `expired:${rule}:${index}`,
          `rule "${rule}" has an exception that ended on ${exception.until} ("${exception.reason}"), so it no longer applies`,
        );
      }
    }
  };
  warnExpired(Date.now());

  return { policy, guard, warnExpired, namesChecked: false };
}

/** Compares declared target names with the first call's targets, to catch a typo. */
export function checkDeclaredNames(live: Live, targets: PreDispatchContext['targets']): void {
  if (live.namesChecked) return;
  live.namesChecked = true;

  for (const name of Object.keys(live.policy.declared)) {
    if (!targets.some((target) => target.name === name)) {
      live.guard.warn(
        `targets declares "${name}", but no target of the first call has that name, so its attributes are never used`,
      );
    }
  }
}
