import { estimateRequestTokens } from '../budgets/requestEstimate.js';
import { nanoToUsd } from './charge.utils.js';
import { estimateNanoUsd } from './estimate.utils.js';

import type { CostFor } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { PriceTable } from './priceTable.js';

/** The most a request could cost on a target, the same worst case a budget holds. */
export function createCostFor(table: PriceTable, guard: Guard): CostFor {
  return (target, request) =>
    guard(
      'costFor',
      () => {
        const price = table.lookup(target.model, target.name);
        if (!price) return undefined;
        const { input, output } = estimateRequestTokens(request);
        return nanoToUsd(estimateNanoUsd(input, output, price));
      },
      undefined,
    );
}
