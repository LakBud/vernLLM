/** `reasoning_effort` as this adapter sends it: VernLLM's tiers, plus OpenAI's `'none'`. */
export type OpenAIWireReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

/** OpenAI's native per-part content shape for a user message. */
export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * OpenAI shaped usage, plus the cache fields providers add. `prompt_cache_hit_tokens` is
 * DeepSeek's; `cache_write_tokens` is on OpenAI's own type and sent by OpenRouter.
 */
export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  prompt_cache_hit_tokens?: number;
}

/** One chunk of an OpenAI-shaped `chat.completions.create({ stream: true })` SSE stream. */
export interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: OpenAIUsage;
}
