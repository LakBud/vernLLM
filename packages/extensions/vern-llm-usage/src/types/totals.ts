import type { BudgetMode, BudgetWindow } from './budgets.js';

/** A context value to match: a key from `attribute` and the value it must have. */
export type AttributionFilter = Readonly<Record<string, string | number | boolean>>;

export interface TotalsOptions {
  /** Which calendar window to read, the current one. Defaults to `'day'`. */
  window?: BudgetWindow;
  /** Only calls answered by this target name. */
  provider?: string;
  /** Only calls answered by this model. */
  model?: string;
}

/** Everything the calls in one window spent, summed over the series that match. */
export interface UsageTotals {
  /** Everything spent, wasted attempts included. Unpriced charges add nothing: a lower bound. */
  estimatedCostUsd: number;
  /** The part spent on attempts whose response was then rejected. */
  wastedUsd: number;
  /** The part spent by chains whose result was not returned, when a call ran more than one. */
  unkeptUsd: number;
  /** An estimate of what cache hits and joins spared, which made no provider call. */
  estimatedSavedUsd: number;
  /** Calls that finished, cache hits and joins included. A call a budget rejected is not one. */
  calls: number;
  /** Charges by where their price came from: the provider, your table, or nowhere. */
  bySource: { reported: number; table: number; unpriced: number };
  /** As the provider reported them: `input` includes cache reads and writes, `reasoning` is inside `output`. */
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  };
  cacheHits: number;
  joins: number;
  /** Aborted streams, whose partial usage the provider never reports. */
  unknownSpendCalls: number;
}

/** One budget as it stands for one context value, in USD for dollar budgets and tokens otherwise. */
export interface BudgetStatus {
  key: string;
  value: string | number | boolean;
  per: BudgetWindow;
  unit: 'usd' | 'tokens';
  limit: number;
  mode: BudgetMode;
  spent: number;
  /** Held for calls in flight. */
  reserved: number;
  /** What is left, never below 0. */
  remaining: number;
  /** How far spend plus holds are past the limit. 0 while within it. */
  overBy: number;
  /** When the window ends and spend starts again from zero, ISO 8601 UTC. */
  resetsAt: string;
}
