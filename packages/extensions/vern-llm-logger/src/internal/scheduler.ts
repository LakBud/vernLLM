import { nowMs } from './clock.utils.js';
import { buildSummary } from './summary.utils.js';
import { unrefTimer, type TimerHandle } from './timers.utils.js';

import type { LogEntry, LogLevel, ResolvedConfig } from '../types/index.js';
import type { ErrorGrouper } from './detectors/errorGrouper.js';
import type { Guard } from './guard.utils.js';
import type { SeriesRegistry } from './stats/seriesRegistry.js';

interface SchedulerDeps {
  config: ResolvedConfig;
  guard: Guard;
  registry: SeriesRegistry;
  groups: ErrorGrouper;
  write: (entry: LogEntry, level: LogLevel) => void;
  now?: () => number;
}

/** One unref'd timer per instance, started by the first call. It only writes output. */
export class Scheduler {
  private timer: TimerHandle | undefined;
  private disposed = false;
  private readonly now: () => number;
  private lastSummaryAtMs: number;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? nowMs;
    this.lastSummaryAtMs = this.now();
  }

  ensureStarted(): void {
    if (this.timer || this.disposed) return;
    const { durationMs, slots } = this.deps.config.window;
    // Never slower than the summary cadence.
    const period = Math.min(durationMs / slots, this.deps.config.summary?.everyMs ?? Infinity);

    this.lastSummaryAtMs = this.now();
    this.timer = setInterval(() => this.tick(), period);
    unrefTimer(this.timer);
  }

  /** Flushes closed error windows, and emits a summary when its period has passed. */
  tick(): void {
    const { config, guard, groups, registry, write } = this.deps;
    const { summary } = config;

    guard(
      'flushErrorGroups',
      () => groups.flush().forEach((entry) => write(entry, 'error')),
      undefined,
    );

    if (!summary || this.now() - this.lastSummaryAtMs < summary.everyMs) return;
    this.lastSummaryAtMs = this.now();

    guard(
      'summary',
      () => {
        const entries = buildSummary(registry);
        if (entries.length === 0) return;
        entries.forEach((entry) => write(entry, 'info'));
        const { onSummary } = summary;
        if (onSummary) guard('onSummary', () => onSummary(entries), undefined);
      },
      undefined,
    );
  }

  /** Stops the timer for good and writes every pending error group. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.disposed = true;

    const { guard, groups, write } = this.deps;
    groups.close();
    guard(
      'disposeFlush',
      () => groups.flush(true).forEach((entry) => write(entry, 'error')),
      undefined,
    );
  }
}
