import { estimateAnswerTokens, estimateRequestTokens } from '../budgets/requestEstimate.js';

import type { Guard } from '../guard.utils.js';
import type { PriceTable } from './priceTable.js';
import type { PreDispatchContext, WireCallRequest } from 'vern-llm';

/**
 * What a hit or join spared: its input and the answer at the primary's price. `undefined` when
 * unpriced.
 */
export type SavedSpend = (
  request: Readonly<WireCallRequest>,
  answer: unknown,
  ctx: Pick<PreDispatchContext, 'primaryModel' | 'primaryProvider'>,
) => number | undefined;

export function createSavedSpend(table: PriceTable, guard: Guard): SavedSpend {
  return (request, answer, ctx) =>
    guard(
      'saved',
      () => {
        const price = table.lookup(ctx.primaryModel, ctx.primaryProvider);
        if (!price) return undefined;
        return (
          estimateRequestTokens(request).input * price.input +
          estimateAnswerTokens(answer) * price.output
        );
      },
      undefined,
    );
}
