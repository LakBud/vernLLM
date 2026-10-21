import type { CallLogRecord, ResolvedConfig } from '../../types/index.js';

/** Whether a timed call is over the threshold or its series' live percentile. */
export function isSlow(
  record: Readonly<CallLogRecord>,
  slowCall: ResolvedConfig['slowCall'],
  livePercentile: () => number | undefined,
): boolean {
  if (slowCall.thresholdMs !== undefined && record.durationMs > slowCall.thresholdMs) return true;
  if (slowCall.aboveLivePercentile === undefined) return false;

  const live = livePercentile();
  return live !== undefined && record.durationMs > live;
}
