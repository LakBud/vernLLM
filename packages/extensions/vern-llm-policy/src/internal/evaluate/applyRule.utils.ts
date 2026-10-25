import type { DecisionException } from '../../types/decision.js';
import type { CallFacts } from '../../types/options.js';
import type { CompiledPolicy, CompiledRule, EvaluatedTarget } from '../../types/resolvedConfig.js';

/** A rule that applies to this call, with what its pattern said about each target. */
export interface AppliedRule {
  id: string;
  /** A `set` rule has flags and no target pattern. */
  kind: 'allow' | 'forbid' | 'set';
  audit: boolean;
  flags: Readonly<Record<string, boolean>> | undefined;
  /** Whether the pattern matched target `i`. */
  hits: boolean[];
}

/**
 * What one rule does for this call, or `undefined` when nothing. A throw follows `onError`: closed
 * applies a forbid and grants nothing for an allow, open skips the rule. An exception that throws
 * covers nothing.
 */
export function applyRule(
  rule: CompiledRule,
  call: CallFacts,
  targets: readonly EvaluatedTarget[],
  now: number,
  onError: CompiledPolicy['onError'],
  note: (rule: string, error: unknown) => void,
  excused: (exception: DecisionException) => void,
): AppliedRule | undefined {
  const closed = onError === 'closed';
  const kind = rule.allow !== undefined ? 'allow' : rule.forbid !== undefined ? 'forbid' : 'set';
  const pattern = rule.allow ?? rule.forbid;
  const audit = rule.mode === 'audit';
  const flags = rule.set;

  if (rule.when !== undefined) {
    try {
      if (!rule.when(call)) return undefined;
    } catch (error) {
      note(rule.id, error);
      if (!closed) return undefined;
      // Cannot tell whether it applies, so an allow grants nothing.
      if (kind === 'allow')
        return { id: rule.id, kind, audit, flags, hits: targets.map(() => false) };
    }
  }

  // An exception that covers the call lifts the rule. An audit rule is not recorded.
  const covering = rule.except.filter((exception) => {
    if (exception.end <= now) return false;
    try {
      return exception.when(call);
    } catch (error) {
      note(rule.id, error);
      return false;
    }
  });
  if (covering.length > 0) {
    if (!audit) {
      for (const { until, reason } of covering) excused({ rule: rule.id, reason, until });
    }
    return undefined;
  }

  const hits: boolean[] = [];
  if (pattern !== undefined) {
    for (const target of targets) {
      try {
        hits.push(pattern(target.facts));
      } catch (error) {
        note(rule.id, error);
        if (kind === 'allow') {
          // An unreadable allow must not stay in force, so open drops it.
          if (!closed) return undefined;
          hits.push(false);
        } else {
          hits.push(closed);
        }
      }
    }
  }

  return { id: rule.id, kind, audit, flags, hits };
}
