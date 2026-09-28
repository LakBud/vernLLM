/** `reasoning_effort` as this adapter sends it: VernLLM's tiers, plus OpenAI's `'none'`. */
export type OpenAIWireReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

/** OpenAI's native per-part content shape for a user message. */
export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

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
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}
