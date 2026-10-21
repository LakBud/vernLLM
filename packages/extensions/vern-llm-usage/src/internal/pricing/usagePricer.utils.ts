import { chargeNanoUsd } from './charge.utils.js';

import type { Guard } from '../guard.utils.js';
import type { PriceTable } from './priceTable.js';
import type { TokenUsage } from 'vern-llm';

/** The nano dollar charge for one usage report, or `undefined` when its model has no price. */
export type UsagePricer = (usage: TokenUsage) => number | undefined;

/** Prices usage from the table, warning once per model that has no price. */
export function createUsagePricer(table: PriceTable, guard: Guard): UsagePricer {
  const unpricedModels = new Set<string>();

  return (usage) => {
    const price = guard('price', () => table.lookup(usage.model, usage.provider), undefined);
    if (!price) {
      if (!unpricedModels.has(usage.model)) {
        unpricedModels.add(usage.model);
        guard.warn(`no price for model "${usage.model}", its calls are counted as unpriced`);
      }
      return undefined;
    }
    return chargeNanoUsd(usage, price);
  };
}
