import type { ResolvedPrice } from '../../types/index.js';

/**
 * The most a call could cost in nano dollars: all output at the dearer of output and reasoning, no
 * cache discount.
 */
export function estimateNanoUsd(
  inputTokens: number,
  outputTokens: number,
  price: ResolvedPrice,
): number {
  return inputTokens * price.input + outputTokens * Math.max(price.output, price.reasoning);
}
