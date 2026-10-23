import { HEALTHY, type Signals } from './signals.js';

import type { ResolvedLimits } from '../../types/index.js';

export type OverReason = 'over_limit' | 'over_deadline';

/** Each limit is checked against the signal of the same name. */
const LIMIT_KEYS = ['latencyMs', 'costUsd', 'qualityFailureRate'] as const;

/** Whether the target is above any limit the route sets. A signal that is unknown is not over. */
function isOverLimit(signal: Signals, limits: ResolvedLimits | undefined): boolean {
  if (!limits) return false;
  return LIMIT_KEYS.some((key) => {
    const max = limits[key];
    const value = signal[key];
    return max !== undefined && value !== undefined && value > max;
  });
}

/** Whether the target's latency estimate is above the time the call has left. */
function isPastDeadline(signal: Signals, timeLeft: number | undefined): boolean {
  const estimate = signal.predictedLatencyMs ?? signal.latencyMs;
  return timeLeft !== undefined && estimate !== undefined && estimate > timeLeft;
}

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
    if (isOverLimit(signal, limits)) over.set(name, 'over_limit');
    else if (isPastDeadline(signal, timeLeft)) over.set(name, 'over_deadline');
  }
  return over;
}
