import { evaluate } from '../../../../src/internal/evaluate/evaluate.js';
import { compile } from '../../../../src/internal/options/compile.utils.js';

import type { CallFacts, PolicyOptions, PolicyRule } from '../../../../src/index.js';
import type { EvaluatedTarget } from '../../../../src/types/resolvedConfig.js';

export type { EvaluatedTarget };

/** Facts for one call. `labels` left out means the labels are unknown, which is not `[]`. */
export const call = (context?: CallFacts['context'], labels?: readonly string[]): CallFacts => ({
  ...(context && { context }),
  ...(labels && { labels }),
  request: { hasTools: false, jsonOutput: false, images: false, inputTokens: 0, streaming: false },
  callTargets: false,
});

export const target = (
  name: string,
  attributes: Record<string, string | boolean> = {},
): EvaluatedTarget => ({
  name,
  facts: { name, model: `${name}-model`, ...attributes },
});

export const us = target('us', { region: 'us', zdr: false });
export const eu = target('eu', { region: 'eu', zdr: true });
export const local = target('local', { region: 'eu', zdr: true, selfHosted: true });
export const all = [us, eu, local];

export const targets = {
  us: { region: 'us', zdr: false },
  eu: { region: 'eu', zdr: true },
  local: { region: 'eu', zdr: true, selfHosted: true },
};

export function decide(
  rules: PolicyRule[],
  options: Partial<PolicyOptions> = {},
  facts: CallFacts = call(),
  among: readonly EvaluatedTarget[] = all,
  now: number = NOW,
) {
  return evaluate(compile({ targets, rules, ...options }), facts, among, now);
}

/** A fixed instant, so no test depends on the clock. */
export const NOW = Date.UTC(2026, 9, 24, 12);

/** Every ordering of `items`, to show a decision does not depend on the order rules are written in. */
export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}
