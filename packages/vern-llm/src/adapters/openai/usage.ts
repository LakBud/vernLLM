import type { OpenAIUsage } from './types.js';

/** Fills `cached_tokens` from DeepSeek's `prompt_cache_hit_tokens` when missing. */
export function normalizeUsage<T extends OpenAIUsage>(usage: T): T {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;

  if (cached === undefined) return usage;

  return {
    ...usage,
    prompt_tokens_details: { ...usage.prompt_tokens_details, cached_tokens: cached },
  };
}
