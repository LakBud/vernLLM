import { evaluate } from '../evaluate/evaluate.js';
import { failedDecision } from '../evaluate/failedDecision.utils.js';
import { callFacts } from '../facts/callFacts.utils.js';
import { readLabels } from '../facts/readLabels.utils.js';
import { targetFacts } from '../facts/targetFacts.utils.js';

import type { Decision } from '../../types/index.js';
import type { EvaluatedTarget } from '../../types/resolvedConfig.js';
import type { Live } from './live.js';
import type { PreDispatchContext, WireCallRequest } from 'vern-llm';

/** Decides one call. `failed` means the policy itself broke, which `onError` then settles. */
export function decideCall(
  live: Live,
  request: Readonly<WireCallRequest>,
  ctx: PreDispatchContext,
  now: number,
): { decision: Decision; failed: boolean } {
  const { policy, guard } = live;

  try {
    const targets: EvaluatedTarget[] = ctx.targets.map((target) => ({
      name: target.name,
      facts: targetFacts(policy, target),
    }));
    const labels = readLabels(policy, ctx);
    let decision = evaluate(
      policy,
      callFacts(ctx, request, policy.needs, labels.labels),
      targets,
      now,
    );

    if (policy.needs.readsLabels && labels.labels === undefined) {
      // Once only: a labeler that never ran is a setup mistake that repeats.
      const why =
        labels.error === undefined ? 'returned undefined' : `failed (${labels.error.name})`;
      guard.warnOnce(
        'labels',
        `the labels function ${why}, so labels are unknown and rules using them fail ${policy.onError}`,
      );
    }
    if (labels.error !== undefined) {
      decision = {
        ...decision,
        errors: [
          { name: labels.error.name, message: `labels: ${labels.error.message}` },
          ...decision.errors,
        ],
      };
    }
    return { decision, failed: false };
  } catch (error) {
    guard.report('evaluate', error);
    return {
      decision: failedDecision(
        policy,
        ctx.targets.map((target) => target.name),
        error,
      ),
      failed: true,
    };
  }
}

/** Warns once per rule, so a rule that throws on every call does not flood the log. */
export function warnRuleErrors(live: Live, decision: Decision): void {
  for (const { rule, name } of decision.errors) {
    if (rule === undefined) continue;
    live.guard.warnOnce(
      `rule:${rule}`,
      `rule "${rule}" threw while deciding a call (${name}), so it fails ${live.policy.onError}`,
    );
  }
}

/** The rule that removed the target a `cachedCall` join was answered by, if any. */
export function joinedRemoved(
  result: { cache?: string; meta?: { provider?: string } },
  decision: Decision,
): { target: string; rule: string } | undefined {
  const answered = result.meta?.provider;
  if (result.cache !== 'join' || answered === undefined) return undefined;
  if (!Object.hasOwn(decision.removed, answered)) return undefined;
  return { target: answered, rule: decision.removed[answered]! };
}
