import { METRICS } from './metrics.utils.js';
import { Ring, RollingSketch } from './rollingSketch.js';

import type { CallLogRecord, MetricName, ResolvedConfig } from '../../types/index.js';
import type { AttemptTally } from './attemptTally.utils.js';

/** Key and dimension of the group that takes every series past `maxSeries`. */
export const OTHER = '__other__';

export interface Counts {
  errors: number;
  rejections: number;
  aborts: number;
  cacheHits: number;
}

export const emptyCounts = (): Counts => ({ errors: 0, rejections: 0, aborts: 0, cacheHits: 0 });

/** Attempts that got a response, and how many of those were rejected as unusable. */
export interface QualityCounts {
  responded: number;
  qualityFailures: number;
}

const emptyQuality = (): QualityCounts => ({ responded: 0, qualityFailures: 0 });

/** One set of dimension values, with a rolling histogram per metric and rolling counters. */
export interface Group {
  dimensions: Record<string, string>;
  series: Map<MetricName, RollingSketch<Readonly<CallLogRecord>>>;
  counts: Ring<Counts>;
  quality: Ring<QualityCounts>;
}

/** Sorted and JSON encoded, so no two dimension sets share a key. */
export function keyOf(dimensions: Record<string, string>): string {
  return JSON.stringify(Object.entries(dimensions).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function makeGroup(config: ResolvedConfig, dimensions: Record<string, string>): Group {
  const { durationMs, slots } = config.window;
  const series = new Map<MetricName, RollingSketch<Readonly<CallLogRecord>>>();
  for (const metric of METRICS) {
    series.set(
      metric,
      new RollingSketch(
        durationMs,
        slots,
        metric === 'durationMs' ? config.slowCall.aboveLivePercentile : undefined,
      ),
    );
  }
  const counts = new Ring<Counts>(slots, durationMs, emptyCounts, (item) =>
    Object.assign(item, emptyCounts()),
  );
  const quality = new Ring<QualityCounts>(slots, durationMs, emptyQuality, (item) =>
    Object.assign(item, emptyQuality()),
  );
  return { dimensions, series, counts, quality };
}

/** The counters summed over the live slots. */
export function totalsOf(group: Group, now: number): Counts {
  const total = emptyCounts();
  for (const slot of group.counts.live(now)) {
    total.errors += slot.errors;
    total.rejections += slot.rejections;
    total.aborts += slot.aborts;
    total.cacheHits += slot.cacheHits;
  }
  return total;
}

/** The quality counters summed over the live slots. */
export function qualityTotalsOf(group: Group, now: number): QualityCounts {
  const total = emptyQuality();
  for (const slot of group.quality.live(now)) {
    total.responded += slot.responded;
    total.qualityFailures += slot.qualityFailures;
  }
  return total;
}

/** Adds one call's attempts on one target to the group. */
export function recordQuality(group: Group, tally: AttemptTally, now: number): void {
  const slot = group.quality.at(now);
  slot.responded += tally.responded;
  slot.qualityFailures += tally.qualityFailures;
}

/** Counts the call's outcome, then its timings when it is one whose latency counts. */
export function recordInto(
  group: Group,
  record: Readonly<CallLogRecord>,
  timed: boolean,
  now: number,
): void {
  const counts = group.counts.at(now);
  if (record.outcome === 'error') counts.errors++;
  else if (record.outcome === 'rejected') counts.rejections++;
  else if (record.outcome === 'aborted') counts.aborts++;
  if (record.cache !== undefined) counts.cacheHits++;
  if (!timed) return;

  const add = (metric: MetricName, value: number | undefined, tag?: Readonly<CallLogRecord>) => {
    if (value !== undefined) group.series.get(metric)?.add(now, value, tag);
  };
  add('durationMs', record.durationMs, record);
  add('queueWaitMs', record.queueWaitMs);
  add('ttftMs', record.ttftMs);
  add('attemptMs', record.attemptMs);
  add('outputTokensPerSec', record.outputTokensPerSec);
  add('outputTokens', record.usage?.completionTokens);
}
