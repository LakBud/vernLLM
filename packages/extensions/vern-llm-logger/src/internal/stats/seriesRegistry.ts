import { nowMs } from '../clock.utils.js';
import { roundMs } from '../recorder/recordMetrics.utils.js';
import { talliesOf } from './attemptTally.utils.js';
import { dimensionsOf } from './dimensions.utils.js';
import {
  keyOf,
  makeGroup,
  OTHER,
  qualityTotalsOf,
  recordInto,
  recordQuality,
  type Group,
} from './group.utils.js';
import { isTimed } from './metrics.utils.js';
import { RollingSketch } from './rollingSketch.js';
import { Sketch } from './sketch.js';
import { snapshotOf } from './snapshot.utils.js';

import type {
  CallLogRecord,
  JsonValue,
  MetricName,
  ResolvedConfig,
  StatsFilter,
  StatsSnapshot,
} from '../../types/index.js';
import type { Guard } from '../guard.utils.js';

/** Rolling series by dimension. Only successful provider calls are timed. */
export class SeriesRegistry {
  private readonly groups = new Map<string, Group>();
  private readonly everything: Group;
  private readonly scratch = new Sketch();
  /** The last record's dimensions, so the extractors run once per call. */
  private memo: { record: object; dimensions: Record<string, string> | undefined } | undefined;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly guard: Guard,
    private readonly now: () => number = nowMs,
  ) {
    this.everything = makeGroup(config, {});
  }

  observe(record: Readonly<CallLogRecord>): void {
    const now = this.now();
    const dimensions = this.dimensionsMemo(record);
    const timed = isTimed(record);

    // The all calls group always sees the call, so a global figure exists without a filter.
    recordInto(this.everything, record, timed, now);
    if (dimensions) recordInto(this.groupFor(dimensions), record, timed, now);

    this.observeAttempts(record, now);
  }

  /**
   * The share of responded attempts rejected as unusable, over every group `filter` matches, or
   * `undefined` below `minSamples` responded attempts.
   */
  failureRate(filter: StatsFilter, kind: 'quality'): number | undefined {
    if (kind !== 'quality') return undefined;

    const now = this.now();
    let responded = 0;
    let failures = 0;
    for (const group of this.matching(filter)) {
      const totals = qualityTotalsOf(group, now);
      responded += totals.responded;
      failures += totals.qualityFailures;
    }

    if (responded < this.config.minSamples) return undefined;
    return failures / responded;
  }

  quantile(filter: StatsFilter, q: number, metric: MetricName = 'durationMs'): number | undefined {
    const now = this.now();
    this.scratch.clear();
    for (const group of this.matching(filter))
      group.series.get(metric)?.mergeInto(now, this.scratch);

    if (this.scratch.count < this.config.minSamples) return undefined;
    return this.scratch.quantile(q);
  }

  /** The slowest call in the window for exactly these dimensions, for a summary's exemplar. */
  exemplarOf(
    dimensions: Readonly<Record<string, string>>,
  ): { requestId: string; durationMs: number; fields?: Record<string, JsonValue> } | undefined {
    const group =
      Object.keys(dimensions).length === 0
        ? this.everything
        : this.groups.get(OTHER in dimensions ? OTHER : keyOf(dimensions));
    const slowest = group?.series.get('durationMs')?.slowest(this.now());
    if (!slowest) return undefined;

    const exemplar: { requestId: string; durationMs: number; fields?: Record<string, JsonValue> } =
      { requestId: slowest.tag.requestId, durationMs: roundMs(slowest.value) };
    const { context } = slowest.tag;
    if (context && Object.keys(context).length > 0) exemplar.fields = { ...context };
    return exemplar;
  }

  /** The cached live percentile of the record's series, or `undefined` below `minSamples`. */
  livePercentileFor(record: Readonly<CallLogRecord>): number | undefined {
    const now = this.now();
    const dimensions = this.dimensionsMemo(record);
    const group = (dimensions && this.groups.get(keyOf(dimensions))) || this.everything;
    const series = group.series.get('durationMs') as RollingSketch<Readonly<CallLogRecord>>;

    if (series.count(now) < this.config.minSamples) return undefined;
    return series.cachedQuantile(now);
  }

  snapshot(): StatsSnapshot {
    return snapshotOf(this.config, [this.everything, ...this.groups.values()], this.now());
  }

  reset(): void {
    this.everything.series.forEach((series) => series.clear());
    this.everything.counts.clear();
    this.everything.quality.clear();
    this.groups.clear();
    this.memo = undefined;
  }

  /**
   * Counts each target's attempts under that target, not the one that answered, so a call a
   * fallback rescued still counts its failures against the target that produced them.
   */
  private observeAttempts(record: Readonly<CallLogRecord>, now: number): void {
    const tallies = talliesOf(record);
    if (!tallies) return;

    // The call's own dimensions, so each extractor still runs once per call. Only the target
    // changes: the user dimensions, such as a route, are the same for every attempt of the call.
    const base = this.dimensionsMemo(record);

    for (const tally of tallies) {
      recordQuality(this.everything, tally, now);
      if (base) {
        const dimensions = { ...base, provider: tally.provider, model: tally.model };
        recordQuality(this.groupFor(dimensions), tally, now);
      }
    }
  }

  /** The groups `filter` matches. The empty filter is the all calls group alone. */
  private matching(filter: StatsFilter): Group[] {
    const keys = Object.keys(filter);
    if (keys.length === 0) return [this.everything];

    return [...this.groups.values()].filter((group) =>
      keys.every((key) => group.dimensions[key] === filter[key]),
    );
  }

  private dimensionsMemo(record: Readonly<CallLogRecord>): Record<string, string> | undefined {
    if (this.memo?.record === record) return this.memo.dimensions;
    const dimensions = dimensionsOf(record, this.config.dimensions, this.guard);
    this.memo = { record, dimensions };
    return dimensions;
  }

  private groupFor(dimensions: Record<string, string>): Group {
    const key = keyOf(dimensions);
    const existing = this.groups.get(key);
    if (existing) return existing;

    if (this.groups.size >= this.config.maxSeries) {
      const overflow = this.groups.get(OTHER);
      if (overflow) return overflow;
      this.guard.warn(
        `more than ${this.config.maxSeries} distinct series, the rest are grouped as ${OTHER}`,
      );
      const created = makeGroup(this.config, { [OTHER]: 'true' });
      this.groups.set(OTHER, created);
      return created;
    }

    const created = makeGroup(this.config, dimensions);
    this.groups.set(key, created);
    return created;
  }
}
