import { nanoToUsd } from '../pricing/charge.utils.js';
import { emptyTokens, type Series } from './series.utils.js';

import type { AttributionFilter, TotalsOptions, UsageTotals } from '../../types/index.js';

/** The series that match `filter` and the provider and model in `options`, summed. */
export function sumSeries(
  series: Iterable<Series>,
  filter: AttributionFilter,
  options: Pick<TotalsOptions, 'provider' | 'model'>,
): UsageTotals {
  const result: UsageTotals = {
    estimatedCostUsd: 0,
    wastedUsd: 0,
    unkeptUsd: 0,
    estimatedSavedUsd: 0,
    calls: 0,
    bySource: { reported: 0, table: 0, unpriced: 0 },
    tokens: emptyTokens(),
    cacheHits: 0,
    joins: 0,
    unknownSpendCalls: 0,
  };
  let nanoUsd = 0;
  let wastedNanoUsd = 0;
  let unkeptNanoUsd = 0;
  let savedNanoUsd = 0;

  for (const entry of series) {
    if (options.provider !== undefined && entry.provider !== options.provider) continue;
    if (options.model !== undefined && entry.model !== options.model) continue;
    if (!Object.entries(filter).every(([k, v]) => entry.attribution[k] === v)) continue;

    nanoUsd += entry.nanoUsd;
    wastedNanoUsd += entry.wastedNanoUsd;
    unkeptNanoUsd += entry.unkeptNanoUsd;
    savedNanoUsd += entry.savedNanoUsd;
    result.calls += entry.calls;
    result.bySource.table += entry.tableCharges;
    result.bySource.reported += entry.reportedCharges;
    result.bySource.unpriced += entry.unpricedCharges;
    for (const k of Object.keys(result.tokens) as (keyof UsageTotals['tokens'])[]) {
      result.tokens[k] += entry.tokens[k];
    }
    result.cacheHits += entry.cacheHits;
    result.joins += entry.joins;
    result.unknownSpendCalls += entry.unknownSpendCalls;
  }

  result.estimatedCostUsd = nanoToUsd(nanoUsd);
  result.wastedUsd = nanoToUsd(wastedNanoUsd);
  result.unkeptUsd = nanoToUsd(unkeptNanoUsd);
  result.estimatedSavedUsd = nanoToUsd(savedNanoUsd);
  return result;
}
