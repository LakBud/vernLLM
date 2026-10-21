import { estimateAnswerTokens, estimateRequestTokens } from '../budgets/requestEstimate.js';

import type { Guard } from '../guard.utils.js';
import type { PriceTable } from './priceTable.js';
import type { PreDispatchContext, WireCallRequest } from 'vern-llm';

/**
 * What a cache hit or join spared, in nano dollars: the request's input and the answer, priced as
 * the primary target would have charged. `undefined` when the primary has no price.
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
