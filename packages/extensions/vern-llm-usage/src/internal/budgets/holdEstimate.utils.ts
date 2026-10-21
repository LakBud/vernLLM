import { estimateNanoUsd } from '../pricing/estimate.utils.js';
import { estimateRequestTokens } from './requestEstimate.js';

import type { Amount } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { PriceTable } from '../pricing/priceTable.js';
import type { PreDispatchContext, WireCallRequest } from 'vern-llm';

/**
 * The most the call could spend, which is what a budget holds before it is sent.
 * `defaultEstimateTokens` already includes `max_tokens`, so the input is what is left of it. Money
 * is priced at the dearest allowed target, from `ctx.targets`, and a target with no price is
 * skipped: with none priced only tokens are held.
 */
export function holdEstimate(
  request: Readonly<WireCallRequest>,
  ctx: Pick<PreDispatchContext, 'targets'>,
  table: PriceTable,
  guard: Guard,
): Amount {
  const { total: tokens, input, output } = estimateRequestTokens(request);

  let nanoUsd = 0;
  for (const target of ctx.targets) {
    const price = guard('estimatePrice', () => table.lookup(target.model, target.name), undefined);
    if (price) nanoUsd = Math.max(nanoUsd, estimateNanoUsd(input, output, price));
  }
  return { nanoUsd, tokens };
}
