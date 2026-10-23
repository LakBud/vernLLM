import { HEALTHY, type Signals } from './signals.js';

import type { ResolvedLimits } from '../../types/index.js';

export type OverReason = 'over_limit' | 'over_deadline';

/**
 * Targets that are over one of the route's soft limits, or whose latency estimate is above the
 * time the call has left. An unknown value never counts as over. `over_limit` wins when both apply.
 */
export function overLimits(
  names: readonly string[],
  signals: ReadonlyMap<string, Signals>,
  limits: ResolvedLimits | undefined,
  now: number | undefined,
  deadlineAt: number | undefined,
): Map<string, OverReason> {
  const over = new Map<string, OverReason>();
  const timeLeft = deadlineAt !== undefined && now !== undefined ? deadlineAt - now : undefined;

  for (const name of names) {
    const signal = signals.get(name) ?? HEALTHY;

    const overLimit =
      (limits?.latencyMs !== undefined &&
        signal.latencyMs !== undefined &&
        signal.latencyMs > limits.latencyMs) ||
      (limits?.costUsd !== undefined &&
        signal.costUsd !== undefined &&
        signal.costUsd > limits.costUsd) ||
      (limits?.qualityFailureRate !== undefined &&
        signal.qualityFailureRate !== undefined &&
        signal.qualityFailureRate > limits.qualityFailureRate);
    if (overLimit) {
      over.set(name, 'over_limit');
      continue;
    }

    const estimate = signal.predictedLatencyMs ?? signal.latencyMs;
    if (timeLeft !== undefined && estimate !== undefined && estimate > timeLeft) {
      over.set(name, 'over_deadline');
    }
  }
  return over;
}
