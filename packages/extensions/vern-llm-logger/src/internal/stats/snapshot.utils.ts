import { roundMs } from '../recorder/recordMetrics.utils.js';
import { totalsOf, type Counts, type Group } from './group.utils.js';
import { METRICS } from './metrics.utils.js';

import type {
  CallLogRecord,
  MetricName,
  ResolvedConfig,
  SeriesSnapshot,
  StatsSnapshot,
} from '../../types/index.js';
import type { RollingSketch } from './rollingSketch.js';

function seriesOf(
  config: ResolvedConfig,
  metric: MetricName,
  group: Group,
  rolling: RollingSketch<Readonly<CallLogRecord>>,
  count: number,
  counts: Counts,
  now: number,
): SeriesSnapshot {
  const quantiles: Record<string, number> = {};
  if (count >= config.minSamples) {
    const values = rolling.quantiles(now, config.percentiles);
    // At least `minSamples` are in the window, so every quantile has a value.
    config.percentiles.forEach((q, index) => {
      quantiles[String(q)] = roundMs(values[index] as number);
    });
  }
  return { metric, dimensions: { ...group.dimensions }, count, quantiles, ...counts };
}

/** Every series with data in the window, group by group, the all calls group first. */
export function snapshotOf(
  config: ResolvedConfig,
  groups: Iterable<Group>,
  now: number,
): StatsSnapshot {
  const series: SeriesSnapshot[] = [];

  for (const group of groups) {
    const counts = totalsOf(group, now);
    const counted = counts.errors + counts.rejections + counts.aborts + counts.cacheHits > 0;
    let emitted = false;

    for (const metric of METRICS) {
      const rolling = group.series.get(metric) as RollingSketch<Readonly<CallLogRecord>>;
      const count = rolling.count(now);
      if (count === 0) continue;

      emitted = true;
      series.push(seriesOf(config, metric, group, rolling, count, counts, now));
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
  return { windowMs: config.window.durationMs, series };
}
