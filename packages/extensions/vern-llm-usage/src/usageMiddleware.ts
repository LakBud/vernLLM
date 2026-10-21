import {
  createMiddlewareRef,
  createStateKey,
  isStreamResult,
  type CallResult,
  type VernLLMMiddleware,
} from 'vern-llm';

import { BudgetGate, type Reservation } from './internal/budgets/gate.js';
import { createRemaining } from './internal/budgets/remaining.utils.js';
import { BudgetWarnings } from './internal/budgets/warnings.js';
import { createGuard } from './internal/guard.utils.js';
import { createCallFinisher } from './internal/middleware/callFinisher.utils.js';
import { normalizeOptions } from './internal/options/normalizeOptions.utils.js';
import { createCostFor } from './internal/pricing/costFor.utils.js';
import { PriceTable } from './internal/pricing/priceTable.js';
import { createSavedSpend } from './internal/pricing/savedSpend.utils.js';
import { warnIfPricesStale } from './internal/pricing/stalePrices.utils.js';
import { createUsagePricer } from './internal/pricing/usagePricer.utils.js';
import { applyEvent } from './internal/recorder/applyEvent.utils.js';
import { CallRecorder } from './internal/recorder/callRecorder.js';
import { TotalsRegistry } from './internal/totals/totalsRegistry.js';
import { memoryUsageStore } from './stores/memoryUsageStore.js';

import type {
  AttributionFilter,
  BudgetStatus,
  CostFor,
  TotalsOptions,
  UsageMiddlewareOptions,
  UsageTotals,
} from './types/index.js';

/** One module level ref, so registering two instances hits the core's duplicate ref check. */
export const usageMiddlewareRef = createMiddlewareRef('usage');

/** The middleware to register, and the reads that belong to this instance. */
export interface UsageMiddleware extends VernLLMMiddleware {
  /**
   * What the calls in the current window spent, summed over those that match `filter`: attributed
   * context keys and their values. Synchronous, from in process counters, so with a shared store
   * it covers this process only.
   */
  totals(filter?: AttributionFilter, options?: TotalsOptions): UsageTotals;

  /**
   * The most `request` could cost on `target`, in USD: the figure a budget holds before the call.
   * `undefined` when the target's model has no price. For a router to weigh targets by cost.
   */
  costFor: CostFor;

  /**
   * Each budget that applies to `filter` with what is left of it. Asynchronous, since budgets live
   * in the store. A budget whose key `filter` lacks does not appear.
   */
  remaining(filter: AttributionFilter): Promise<BudgetStatus[]>;
}

export function usageMiddleware(options: UsageMiddlewareOptions): UsageMiddleware {
  const config = normalizeOptions(options);
  const guard = createGuard(config.logger);
  const table = new PriceTable(config);
  const store = config.store ?? memoryUsageStore({ onWarning: guard.warn });
  const gate = new BudgetGate(config, store, table, guard);
  const warnings = new BudgetWarnings(config.warnAt, store, guard);
  const registry = new TotalsRegistry(config.maxSeries, config.timeZone, (message) =>
    guard.warn(message),
  );
  const priceUsage = createUsagePricer(table, guard);
  const { finish, observeStream } = createCallFinisher({
    guard,
    gate,
    warnings,
    registry,
    savedSpend: createSavedSpend(table, guard),
    attribute: config.attribute,
  });

  warnIfPricesStale(config, guard);

  // Created per factory call, so it can never collide with another instance or a user key.
  const recorderKey = createStateKey<CallRecorder>('usage.recorder');

  // No `enabled` on purpose: a function `enabled` makes the core deliver `onEvent`
  // asynchronously, and the charge relies on `usage` landing before the call finishes.
  return {
    name: 'usage',
    ref: usageMiddlewareRef,
    // Inside the logger (outermost), and outside any router at position 0.
    position: -50,

    wrap: async (request, next, ctx) => {
      const recorder = new CallRecorder();
      guard('registerRecorder', () => ctx.state.set(recorderKey, recorder), undefined);

      // Throws `budget_exceeded` before any provider is contacted.
      const reservation: Reservation | undefined = gate.active
        ? await gate.reserve(request, ctx)
        : undefined;
      const call = { recorder, request, ctx, reservation };

      let result: CallResult;
      try {
        result = await next();
      } catch (error) {
        // A rejected call can still have spent tokens, reported as `usage_failure`.
        await finish(call, undefined, false);
        // The exact error `next` threw, so callers see what they would without this entry.
        throw error;
      }

      if (isStreamResult(result.value)) {
        // A stream's usage arrives while it is read, so the call ends when `finalResult` settles.
        // This runs before any outer middleware's observer, since this `wrap` returns first.
        observeStream(call, result.cache, result.value);
        return result;
      }

      await finish(call, result.cache, false, result.value);
      return result;
    },

    onEvent: (event, ctx) => {
      guard(
        'handleEvent',
        () => {
          const recorder = ctx?.state.get(recorderKey);
          if (recorder) applyEvent(recorder, event, priceUsage);
        },
        undefined,
      );
    },

    costFor: createCostFor(table, guard),

    totals: (filter = {}, totalsOptions = {}) => registry.read(filter, totalsOptions, Date.now()),

    remaining: createRemaining(config, store),
  };
}
