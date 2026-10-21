import { nowMs } from '../clock.utils.js';
import { Ring, RollingSketch } from './rollingSketch.js';
import { Sketch } from './sketch.js';

import type {
  CallLogRecord,
  JsonValue,
  MetricName,
  ResolvedConfig,
  SeriesSnapshot,
  StatsFilter,
  StatsSnapshot,
} from '../../types/index.js';
import type { Guard } from '../guard.utils.js';

export const METRICS: readonly MetricName[] = [
  'durationMs',
  'ttftMs',
  'attemptMs',
  'queueWaitMs',
  'outputTokensPerSec',
];

const OTHER = '__other__';
/** A longer dimension value is cut, so one runaway string cannot bloat a key or a log line. */
const MAX_DIMENSION_LENGTH = 128;

interface Counts {
  errors: number;
  rejections: number;
  aborts: number;
  cacheHits: number;
}

const emptyCounts = (): Counts => ({ errors: 0, rejections: 0, aborts: 0, cacheHits: 0 });

/** One set of dimension values, with a rolling histogram per metric and rolling counters. */
interface Group {
  dimensions: Record<string, string>;
  series: Map<MetricName, RollingSketch<Readonly<CallLogRecord>>>;
  counts: Ring<Counts>;
}

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
    this.everything = this.makeGroup({});
  }

  observe(record: Readonly<CallLogRecord>): void {
    const now = this.now();
    const dimensions = this.dimensionsMemo(record);
    const timed = isTimed(record);

    // The all calls group always sees the call, so a global figure exists without a filter.
    this.record(this.everything, record, timed, now);
    if (dimensions) this.record(this.groupFor(dimensions), record, timed, now);
  }

  /** The groups `filter` matches. The empty filter is the all calls group alone. */
  private matching(filter: StatsFilter): Group[] {
    const keys = Object.keys(filter);
    if (keys.length === 0) return [this.everything];

    return [...this.groups.values()].filter((group) =>
      keys.every((key) => group.dimensions[key] === filter[key]),
    );
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
      { requestId: slowest.tag.requestId, durationMs: round(slowest.value) };
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
    const now = this.now();
    const series: SeriesSnapshot[] = [];

    for (const group of [this.everything, ...this.groups.values()]) {
      const counts = this.totals(group, now);
      const counted = counts.errors + counts.rejections + counts.aborts + counts.cacheHits > 0;
      let emitted = false;

      for (const metric of METRICS) {
        const rolling = group.series.get(metric) as RollingSketch<Readonly<CallLogRecord>>;
        const count = rolling.count(now);
        if (count === 0) continue;

        emitted = true;
        series.push(this.snapshotOf(metric, group, rolling, count, counts, now));
      }

      // A group that only failed still has counters worth showing.
      if (!emitted && counted) {
        series.push({
          metric: 'durationMs',
          dimensions: { ...group.dimensions },
          count: 0,
          quantiles: {},
          ...counts,
        });
      }
    }
    return { windowMs: this.config.window.durationMs, series };
  }

  reset(): void {
    this.everything.series.forEach((series) => series.clear());
    this.everything.counts.clear();
    this.groups.clear();
    this.memo = undefined;
  }

  private dimensionsMemo(record: Readonly<CallLogRecord>): Record<string, string> | undefined {
    if (this.memo?.record === record) return this.memo.dimensions;
    const dimensions = this.dimensionsOf(record);
    this.memo = { record, dimensions };
    return dimensions;
  }

  private snapshotOf(
    metric: MetricName,
    group: Group,
    rolling: RollingSketch<Readonly<CallLogRecord>>,
    count: number,
    counts: Counts,
    now: number,
  ): SeriesSnapshot {
    const quantiles: Record<string, number> = {};
    if (count >= this.config.minSamples) {
      const values = rolling.quantiles(now, this.config.percentiles);
      // At least `minSamples` are in the window, so every quantile has a value.
      this.config.percentiles.forEach((q, index) => {
        quantiles[String(q)] = round(values[index] as number);
      });
    }
    return { metric, dimensions: { ...group.dimensions }, count, quantiles, ...counts };
  }

  private totals(group: Group, now: number): Counts {
    const total = emptyCounts();
    for (const slot of group.counts.live(now)) {
      total.errors += slot.errors;
      total.rejections += slot.rejections;
      total.aborts += slot.aborts;
      total.cacheHits += slot.cacheHits;
    }
    return total;
  }

  private record(group: Group, record: Readonly<CallLogRecord>, timed: boolean, now: number): void {
    const counts = group.counts.at(now);
    if (record.outcome === 'error') counts.errors++;
    else if (record.outcome === 'rejected') counts.rejections++;
    else if (record.outcome === 'aborted') counts.aborts++;
    if (record.cache !== undefined) counts.cacheHits++;
    if (!timed) return;

    this.add(group, 'durationMs', now, record.durationMs, record);
    this.add(group, 'queueWaitMs', now, record.queueWaitMs);
    this.add(group, 'ttftMs', now, record.ttftMs);
    this.add(group, 'attemptMs', now, record.attemptMs);
    this.add(group, 'outputTokensPerSec', now, record.outputTokensPerSec);
  }

  private add(
    group: Group,
    metric: MetricName,
    now: number,
    value: number | undefined,
    tag?: Readonly<CallLogRecord>,
  ): void {
    if (value === undefined) return;
    group.series.get(metric)?.add(now, value, tag);
  }

  private makeGroup(dimensions: Record<string, string>): Group {
    const { durationMs, slots } = this.config.window;
    const series = new Map<MetricName, RollingSketch<Readonly<CallLogRecord>>>();
    for (const metric of METRICS) {
      series.set(
        metric,
        new RollingSketch(
          durationMs,
          slots,
          metric === 'durationMs' ? this.config.slowCall.aboveLivePercentile : undefined,
        ),
      );
    }
    const counts = new Ring<Counts>(slots, durationMs, emptyCounts, (item) =>
      Object.assign(item, emptyCounts()),
    );
    return { dimensions, series, counts };
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
      const created = this.makeGroup({ [OTHER]: 'true' });
      this.groups.set(OTHER, created);
      return created;
    }

    const created = this.makeGroup(dimensions);
    this.groups.set(key, created);
    return created;
  }

  /** The built in dimensions plus every user dimension that yields a non empty string. */
  private dimensionsOf(record: Readonly<CallLogRecord>): Record<string, string> | undefined {
    const last = record.path[record.path.length - 1];
    const provider = record.provider ?? last?.provider;
    const model = record.model ?? last?.model;
    if (provider === undefined || model === undefined) return undefined;

    const dimensions: Record<string, string> = {
      provider,
      model,
      streaming: String(record.streaming),
    };
    for (const [name, extractor] of this.config.dimensions) {
      const value = this.guard(`dimension.${name}`, () => extractor(record), undefined);
      if (typeof value === 'string' && value !== '') {
        dimensions[name] = value.slice(0, MAX_DIMENSION_LENGTH);
      }
    }
    return dimensions;
  }
}

/** A successful call that went to a provider: the only kind whose latency is a latency. */
export function isTimed(record: Readonly<CallLogRecord>): boolean {
  return (
    record.outcome === 'ok' &&
    record.cache === undefined &&
    record.attempts > 0 &&
    record.shortCircuitedBy === undefined
  );
}

/** Sorted and JSON encoded, so no two dimension sets share a key. */
function keyOf(dimensions: Record<string, string>): string {
  return JSON.stringify(Object.entries(dimensions).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const round = (value: number): number => Math.round(value * 1000) / 1000;
