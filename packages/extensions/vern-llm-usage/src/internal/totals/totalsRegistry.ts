import { windowFor } from '../budgets/windows.utils.js';
import {
  addCallToSeries,
  addPartToSeries,
  emptySeries,
  OTHER,
  type CallOutcome,
  type Series,
} from './series.utils.js';
import { sumSeries } from './sumSeries.utils.js';

import type {
  AttributionFilter,
  BudgetWindow,
  TotalsOptions,
  UsageTotals,
} from '../../types/index.js';

export type { CallOutcome } from './series.utils.js';

const WINDOWS: readonly BudgetWindow[] = ['hour', 'day', 'month'];

/**
 * In process counters by window, provider, model and attribution values: a call's spend is split
 * by the target that produced each charge, and the call is counted on the one that answered. Per
 * process on purpose,
 * even with a shared store: budgets are what must agree across processes, reporting need not.
 *
 * Each window kind keeps its current and previous window, so memory is bounded by `maxSeries`
 * times two times three.
 */
export class TotalsRegistry {
  /** Per kind, window id to series, oldest window first. */
  private readonly windows = new Map<BudgetWindow, Map<string, Map<string, Series>>>(
    WINDOWS.map((kind) => [kind, new Map()]),
  );
  private warned = false;

  constructor(
    private readonly maxSeries: number,
    private readonly timeZone: string,
    private readonly onWarning: (message: string) => void,
  ) {}

  add(outcome: CallOutcome, nowMs: number): void {
    const { snapshot } = outcome;
    const provider = snapshot.provider ?? outcome.fallbackProvider;
    const model = snapshot.model ?? outcome.fallbackModel;

    for (const kind of WINDOWS) {
      // Each charge goes to the target that produced it, so a fallback does not take the primary's
      // wasted attempt. The call itself is counted once, on the target that answered.
      for (const part of snapshot.parts) {
        const target = this.seriesFor(
          kind,
          nowMs,
          part.provider ?? outcome.fallbackProvider,
          part.model ?? outcome.fallbackModel,
          outcome.attribution,
        );
        addPartToSeries(target, part);
      }
      addCallToSeries(this.seriesFor(kind, nowMs, provider, model, outcome.attribution), outcome);
    }
  }

  /** The current window's series that match, summed. Zeros when nothing matches. */
  read(filter: AttributionFilter, options: TotalsOptions, nowMs: number): UsageTotals {
    const kind = options.window ?? 'day';
    const window = this.windows.get(kind)?.get(windowFor(kind, nowMs, this.timeZone).id);
    return sumSeries(window?.values() ?? [], filter, options);
  }

  private seriesFor(
    kind: BudgetWindow,
    nowMs: number,
    provider: string,
    model: string,
    attribution: Series['attribution'],
  ): Series {
    const kindWindows = this.windows.get(kind)!;
    const id = windowFor(kind, nowMs, this.timeZone).id;

    let window = kindWindows.get(id);
    if (!window) {
      window = new Map();
      kindWindows.set(id, window);
      // Keep this window and the one before it.
      while (kindWindows.size > 2) kindWindows.delete(kindWindows.keys().next().value!);
    }

    const key = JSON.stringify([provider, model, attribution]);
    const existing = window.get(key);
    if (existing) return existing;

    if (window.size >= this.maxSeries) {
      if (!this.warned) {
        this.warned = true;
        this.onWarning(
          `totals reached maxSeries (${this.maxSeries}), so new series are counted as ${OTHER}`,
        );
      }
      const otherKey = JSON.stringify([OTHER, OTHER, {}]);
      let other = window.get(otherKey);
      if (!other) {
        other = emptySeries(OTHER, OTHER, {});
        window.set(otherKey, other);
      }
      return other;
    }

    const created = emptySeries(provider, model, attribution);
    window.set(key, created);
    return created;
  }
}
