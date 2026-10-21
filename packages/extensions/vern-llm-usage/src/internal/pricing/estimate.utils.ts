import type { ResolvedPrice } from '../../types/index.js';

/**
 * The most a call could cost in integer nano dollars, for a reservation. Worst case on purpose: a
 * reservation that is too large is released at settle, and one that is too small lets parallel calls
 * overshoot. All output is priced as the dearer of output and reasoning, and no cache discount is
 * assumed.
 */
export function estimateNanoUsd(
  inputTokens: number,
  outputTokens: number,
  price: ResolvedPrice,
): number {
  return inputTokens * price.input + outputTokens * Math.max(price.output, price.reasoning);
}
