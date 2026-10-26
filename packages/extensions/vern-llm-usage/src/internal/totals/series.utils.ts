import type { UsageTotals } from '../../types/index.js';
import type { CallSnapshot, ChargePart } from '../recorder/callRecorder.js';

export const OTHER = '__other__';

type Attribution = Readonly<Record<string, string | number | boolean>>;

/** The running sums for one provider, model and set of attribution values in one window. */
export interface Series {
  provider: string;
  model: string;
  attribution: Attribution;
  nanoUsd: number;
  wastedNanoUsd: number;
  unkeptNanoUsd: number;
  savedNanoUsd: number;
  calls: number;
  tableCharges: number;
  reportedCharges: number;
  unpricedCharges: number;
  tokens: UsageTotals['tokens'];
  cacheHits: number;
  joins: number;
  unknownSpendCalls: number;
}

/** What one finished call adds to the totals. */
export interface CallOutcome {
  snapshot: CallSnapshot;
  /** Who answered, when the call never was charged: the primary target. */
  fallbackProvider: string;
  fallbackModel: string;
  attribution: Attribution;
  /** What a hit or join spared, when it could be estimated. */
  savedNanoUsd?: number | undefined;
  cache: 'hit' | 'join' | undefined;
  unknownSpend: boolean;
}

export const emptyTokens = (): UsageTotals['tokens'] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
});

export const emptySeries = (provider: string, model: string, attribution: Attribution): Series => ({
  provider,
  model,
  attribution,
  nanoUsd: 0,
  wastedNanoUsd: 0,
  unkeptNanoUsd: 0,
  savedNanoUsd: 0,
  calls: 0,
  tableCharges: 0,
  reportedCharges: 0,
  unpricedCharges: 0,
  tokens: emptyTokens(),
  cacheHits: 0,
  joins: 0,
  unknownSpendCalls: 0,
});

/** Adds the charges one provider and model produced for a call to that target's series. */
export function addPartToSeries(series: Series, part: ChargePart): void {
  series.nanoUsd += part.nanoUsd;
  series.wastedNanoUsd += part.wastedNanoUsd;
  series.unkeptNanoUsd += part.unkeptNanoUsd;
  series.tableCharges += part.tableCharges;
  series.reportedCharges += part.reportedCharges;
  series.unpricedCharges += part.unpricedCharges;
  for (const k of Object.keys(series.tokens) as (keyof Series['tokens'])[]) {
    series.tokens[k] += part.tokens[k];
  }
}

/** Counts one finished call on the series of the target that answered it. */
export function addCallToSeries(series: Series, outcome: CallOutcome): void {
  series.savedNanoUsd += outcome.savedNanoUsd ?? 0;
  series.calls++;
  if (outcome.cache === 'hit') series.cacheHits++;
  if (outcome.cache === 'join') series.joins++;
  if (outcome.unknownSpend) series.unknownSpendCalls++;
}
