import { isSlow } from '../detectors/slowCall.utils.js';
import { isTimed } from '../stats/metrics.utils.js';
import { shouldKeep } from './sample.utils.js';

import type {
  BreakerEntry,
  CallLogRecord,
  LogEntry,
  LogLevel,
  ResolvedConfig,
} from '../../types/index.js';
import type { ErrorGrouper } from '../detectors/errorGrouper.js';
import type { Guard } from '../guard.utils.js';
import type { SeriesRegistry } from '../stats/seriesRegistry.js';

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Takes a finished entry to the sink: stats, slow call, error grouping, sampling, level.
 * Entries other than calls only pass the level filter.
 */
export function createFinalize(
  config: ResolvedConfig,
  guard: Guard,
  registry: SeriesRegistry,
  groups: ErrorGrouper,
) {
  let reportedRejection = false;
  const minimum = LEVEL_RANK[config.level];

  const write = (level: LogLevel, entry: LogEntry): void => {
    if (LEVEL_RANK[level] < minimum) return;

    const pending: unknown = guard('sink.write', () => config.sink.write(level, entry), undefined);

    if (typeof (pending as { then?: unknown } | undefined)?.then === 'function') {
      (pending as PromiseLike<void>).then(undefined, (error: unknown) => {
        if (reportedRejection) return;
        reportedRejection = true;
        guard.report('sink.write', error);
      });
    }
  };

  const callPipeline = (original: CallLogRecord): void => {
    guard('stats.observe', () => registry.observe(original), undefined);

    let record = original;
    const slow = guard(
      'slowCall',
      () =>
        isTimed(record) &&
        isSlow(record, config.slowCall, () => registry.livePercentileFor(record)),
      false,
    );
    // Raised to `warn`, never lowered: a failure that is also slow keeps its own level.
    if (slow) {
      record = Object.freeze({
        ...record,
        level: LEVEL_RANK[record.level] < LEVEL_RANK.warn ? ('warn' as const) : record.level,
        reason: 'slow' as const,
      });
    }

    if (config.errorGrouping && record.outcome === 'error') {
      if (!guard('errorGroup', () => groups.offer(record), true)) return;
    }

    // Tail sampling: only plain successes are ever dropped. Aborted, slow, rejected,
    // errored and breaker changing calls are always kept.
    if (
      record.outcome === 'ok' &&
      record.reason === undefined &&
      !record.breaker?.length &&
      !guard('sample', () => shouldKeep(record.requestId, config.sampleSuccess), true)
    ) {
      return;
    }

    write(record.level, record);
  };

  return (entry: CallLogRecord | BreakerEntry | LogEntry, level?: LogLevel): void => {
    if (entry.kind === 'call') callPipeline(entry);
    else write(level ?? 'info', entry);
  };
}
