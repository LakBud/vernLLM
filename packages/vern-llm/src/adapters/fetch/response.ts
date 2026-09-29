import type { WireToolCall } from '../../types/index.js';
import type { FetchAdapterConfig } from './types.js';

type MappedUsage = NonNullable<ReturnType<FetchAdapterConfig['mapResponse']>['usage']>;

function hasCacheCounts(usage: MappedUsage): boolean {
  return (
    usage.cacheReadTokens !== undefined ||
    usage.cacheWriteTokens !== undefined ||
    usage.cacheWriteTokensByTtl !== undefined
  );
}

/** Maps what `mapResponse` returned onto the wire response. */
export function toWireResponse(mapped: ReturnType<FetchAdapterConfig['mapResponse']>) {
  const { content, usage, toolCalls } = mapped;

  // An empty array means no tool calls, the same as undefined.
  const wireToolCalls: WireToolCall[] | undefined = toolCalls?.length
    ? toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }))
    : undefined;

  return {
    choices: [
      {
        message: {
          content,
          ...(wireToolCalls ? { tool_calls: wireToolCalls } : {}),
        },
      },
    ],
    usage: usage
      ? {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
          ...(hasCacheCounts(usage)
            ? {
                prompt_tokens_details: {
                  cached_tokens: usage.cacheReadTokens,
                  cache_write_tokens: usage.cacheWriteTokens,
                  cache_write_tokens_by_ttl: usage.cacheWriteTokensByTtl,
                },
              }
            : {}),
        }
      : undefined,
  };
}
