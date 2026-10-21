import type { SummaryEntry } from '../types/index.js';
import type { SeriesRegistry } from './stats/seriesRegistry.js';

/** One entry per live series, with an exemplar on the duration series. */
export function buildSummary(registry: SeriesRegistry): SummaryEntry[] {
  return registry.snapshot().series.map((series) => {
    const entry: SummaryEntry = { kind: 'summary', v: 1, series };
    const exemplar =
      series.metric === 'durationMs' ? registry.exemplarOf(series.dimensions) : undefined;
    if (exemplar) entry.exemplar = exemplar;
    return entry;
  });
}
