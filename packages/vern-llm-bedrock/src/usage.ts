import type { TokenUsage } from '@aws-sdk/client-bedrock-runtime';

/**
 * Bedrock usage in the wire shape. `inputTokens` excludes cache counts and `totalTokens` includes
 * them, so the cache counts are added to the prompt count and the total is kept as reported.
 */
export function toWireUsage(usage: TokenUsage | undefined) {
  const reads = usage?.cacheReadInputTokens ?? 0;
  const writes = usage?.cacheWriteInputTokens ?? 0;

  // A detail without a TTL label can't be keyed, so it is left out of the split.
  const byTtl = Object.fromEntries(
    (usage?.cacheDetails ?? []).flatMap((detail) =>
      detail.ttl === undefined ? [] : [[detail.ttl, detail.inputTokens ?? 0] as const],
    ),
  );

  return {
    prompt_tokens:
      usage?.inputTokens === undefined ? undefined : usage.inputTokens + reads + writes,
    completion_tokens: usage?.outputTokens,
    total_tokens: usage?.totalTokens,
    prompt_tokens_details: {
      cached_tokens: usage?.cacheReadInputTokens,
      cache_write_tokens: usage?.cacheWriteInputTokens,
      ...(Object.keys(byTtl).length ? { cache_write_tokens_by_ttl: byTtl } : {}),
    },
  };
}
