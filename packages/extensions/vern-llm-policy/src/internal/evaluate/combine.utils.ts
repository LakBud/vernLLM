import { DEFAULT_CAUSE } from '../../types/resolvedConfig.js';

import type { AppliedRule } from './applyRule.utils.js';

/**
 * The rule that removed each target by position, or `undefined` if it stays. Allows add up, then
 * every forbid is tested and the smallest id is named, so rule order never matters.
 */
export function combine(
  rules: readonly AppliedRule[],
  effect: 'allow' | 'deny',
  count: number,
): (string | undefined)[] {
  const allows = rules.filter((rule) => rule.kind === 'allow');
  const forbids = rules.filter((rule) => rule.kind === 'forbid');

  // No allow reaches the target: name the smallest allow rule.
  let allowCause: string | undefined;
  for (const rule of allows) {
    if (allowCause === undefined || rule.id < allowCause) allowCause = rule.id;
  }

  const causes: (string | undefined)[] = [];
  for (let i = 0; i < count; i++) {
    let cause: string | undefined;
    for (const rule of forbids) {
      if (rule.hits[i] && (cause === undefined || rule.id < cause)) cause = rule.id;
    }

    if (cause === undefined) {
      if (allows.length > 0) {
        if (!allows.some((rule) => rule.hits[i])) cause = allowCause;
      } else if (effect === 'deny') {
        cause = DEFAULT_CAUSE;
      }
    }
    causes.push(cause);
  }
  return causes;
}
