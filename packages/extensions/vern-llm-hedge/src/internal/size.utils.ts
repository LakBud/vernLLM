import { defaultEstimateTokens, type WireCallRequest } from 'vern-llm';

/**
 * The logger dimension the hedge reads for a prompt's size. Register it under this name:
 * `dimensions: { size: promptSizeDimension }`.
 */
export const SIZE_DIMENSION = 'size';

export type SizeBucket = 'xs' | 's' | 'm' | 'l' | 'xl';

/** Upper edges, in prompt tokens: under 1k, 4k, 16k and 64k, and everything above. */
const EDGES = [1_000, 4_000, 16_000, 64_000] as const;
const NAMES = ['xs', 's', 'm', 'l'] as const;

export function bucketOfTokens(promptTokens: number): SizeBucket {
  for (const [index, edge] of EDGES.entries()) {
    if (promptTokens < edge) return NAMES[index]!;
  }
  return 'xl';
}

/**
 * The bucket of a request that has not been sent yet. It is an estimate, so a prompt near an edge
 * may land beside the bucket the logger later records it in. The core's estimate reserves `max_tokens`
 * for the answer, which the logger's recorded prompt tokens never include, so it is taken off.
 */
export function bucketOfRequest(request: Readonly<WireCallRequest>): SizeBucket {
  const prompt = defaultEstimateTokens(request) - (request.max_tokens ?? 0);
  return bucketOfTokens(Math.max(0, prompt));
}
