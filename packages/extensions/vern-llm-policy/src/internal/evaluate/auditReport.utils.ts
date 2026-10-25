import {
  DEFAULT_CAUSE,
  type CompiledPolicy,
  type EvaluatedTarget,
} from '../../types/resolvedConfig.js';
import { combine } from './combine.utils.js';
import { NO_AUDIT } from './empty.js';

import type { AppliedRule } from './applyRule.utils.js';

/** For each audit rule, the allowed targets it would remove. `'default'` is `default: 'deny'`. */
export function auditReport(
  policy: CompiledPolicy,
  enforced: readonly AppliedRule[],
  audited: readonly AppliedRule[],
  causes: readonly (string | undefined)[],
  effect: 'allow' | 'deny',
  targets: readonly EvaluatedTarget[],
): Readonly<Record<string, readonly string[]>> {
  const wouldRemove = (hypothetical: (string | undefined)[]): string[] =>
    targets
      .filter((_, i) => causes[i] === undefined && hypothetical[i] !== undefined)
      .map((target) => target.name);

  const entries: [string, string[]][] = [];
  for (const rule of audited) {
    const names = wouldRemove(combine([...enforced, rule], effect, targets.length));
    if (names.length > 0) entries.push([rule.id, names]);
  }
  if (policy.auditDefault && policy.default === 'deny') {
    const names = wouldRemove(combine(enforced, 'deny', targets.length));
    if (names.length > 0) entries.push([DEFAULT_CAUSE, names]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : NO_AUDIT;
}
