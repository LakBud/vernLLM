import type { CallLogRecord, MetricName } from '../../types/index.js';

export const METRICS: readonly MetricName[] = [
  'durationMs',
  'ttftMs',
  'attemptMs',
  'queueWaitMs',
  'outputTokensPerSec',
  'outputTokens',
];

/** A successful call that went to a provider: the only kind whose latency is a latency. */
export function isTimed(record: Readonly<CallLogRecord>): boolean {
  return (
    record.outcome === 'ok' &&
    record.cache === undefined &&
    record.attempts > 0 &&
    record.shortCircuitedBy === undefined
  );
}
