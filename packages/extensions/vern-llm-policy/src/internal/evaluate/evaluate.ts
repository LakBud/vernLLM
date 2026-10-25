import {
  DEFAULT_CAUSE,
  type CompiledPolicy,
  type EvaluatedTarget,
} from '../../types/resolvedConfig.js';
import { applyRule } from './applyRule.utils.js';
import { auditReport } from './auditReport.utils.js';
import { combine } from './combine.utils.js';
import { NO_EXCEPTIONS, NO_REMOVALS } from './empty.js';
import { createErrorLog } from './errorLog.utils.js';
import { mergeFlags } from './mergeFlags.utils.js';
import { byError, byException } from './sort.utils.js';

import type { Decision, DecisionException } from '../../types/decision.js';
import type { CallFacts } from '../../types/options.js';

/**
 * Decides which targets a call may use. Pure and synchronous. Rules are combined with set
 * operations, and audit rules are reported without being enforced.
 */
export function evaluate(
  policy: CompiledPolicy,
  call: CallFacts,
  targets: readonly EvaluatedTarget[],
  now: number = Date.now(),
): Decision {
  const { errors, note } = createErrorLog();
  const exceptions: DecisionException[] = [];

  const applied = policy.rules.flatMap(
    (rule) =>
      applyRule(rule, call, targets, now, policy.onError, note, (e) => exceptions.push(e)) ?? [],
  );
  const enforced = applied.filter((rule) => !rule.audit);
  const audited = applied.filter((rule) => rule.audit);

  // Under an audit policy the default only reports.
  const effect = policy.auditDefault ? 'allow' : policy.default;
  const causes = combine(enforced, effect, targets.length);

  const allowed = targets.filter((_, i) => causes[i] === undefined).map((target) => target.name);
  const removed = targets.flatMap((target, i) =>
    causes[i] === undefined ? [] : [[target.name, causes[i]!] as const],
  );

  return {
    ...(policy.version !== undefined && { version: policy.version }),
    outcome: outcomeOf(allowed.length, removed.length),
    allowed,
    // `fromEntries` keeps a `__proto__` target or rule plain data.
    removed: removed.length > 0 ? Object.fromEntries(removed) : NO_REMOVALS,
    rules: [...new Set(removed.map(([, cause]) => cause))]
      .filter((cause) => cause !== DEFAULT_CAUSE)
      .sort(),
    audit: auditReport(policy, enforced, audited, causes, effect, targets),
    // Sorted, so rule order never shows.
    errors: errors.sort(byError),
    ...mergeFlags(enforced),
    exceptions: exceptions.length > 0 ? exceptions.sort(byException) : NO_EXCEPTIONS,
    ...(policy.needs.labels && policy.labels !== undefined && { labels: describeLabels(call) }),
  };
}

function outcomeOf(allowed: number, removed: number): Decision['outcome'] {
  if (allowed === 0) return 'denied';
  return removed > 0 ? 'narrowed' : 'allowed';
}

/** Sorted and without repeats. */
function describeLabels(call: CallFacts): readonly string[] | 'unknown' {
  return call.labels === undefined ? 'unknown' : [...new Set(call.labels)].sort();
}
