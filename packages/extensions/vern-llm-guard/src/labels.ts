import { createStateKey, type JsonValue, type MiddlewareStateBag } from 'vern-llm';

import type { GuardOutcome } from './types/index.js';

/** Module level so a reader does not need the guard instance. */
export const guardLabelsKey = createStateKey<readonly string[]>('guard.labels');

/** What the guard did to the call, for a log record to carry. */
export interface GuardSummary {
  outcome: GuardOutcome;
  /** Absent when unknown. */
  labels?: readonly string[];
  ms: number;
}

export const guardSummaryKey = createStateKey<GuardSummary>('guard.summary');

/** The part of a context the readers need, so any hook's `ctx` fits. */
interface WithState {
  state: MiddlewareStateBag;
}

/**
 * What the guard found, for a policy to decide on: `['pii']`, or `[]` when it looked and found
 * nothing. `undefined` means unknown: the guard did not run for this call, or a check that labels
 * could not answer. Pass it as policy's `labels` option.
 */
export function guardLabels(ctx: WithState): readonly string[] | undefined {
  return ctx.state.get(guardLabelsKey);
}

/**
 * Fields for a log record: `guard_outcome`, `guard_labels` (absent when unknown) and `guard_ms`.
 * `undefined` when the guard did not run. Pass it to the logger's `fields` option.
 */
export function guardLogFields(ctx: WithState): Record<string, JsonValue> | undefined {
  const summary = ctx.state.get(guardSummaryKey);
  if (summary === undefined) return undefined;

  return {
    guard_outcome: summary.outcome,
    ...(summary.labels !== undefined && { guard_labels: [...summary.labels] }),
    guard_ms: summary.ms,
  };
}
