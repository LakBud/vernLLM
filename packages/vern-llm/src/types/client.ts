/**
 * Minimal shape compatible with the OpenAI SDKs chat.completions.create,
 * so consumers can pass an OpenAI client directly
 * `response_format.json_schema` and `reasoning_effort` are optional on the wire
 * providers that don't support them will just ignore fields they don't recognize,
 * but not every SDKs TS types accept them, hence this being a structural type
 * rather than importing the SDKs own params type
 */
export interface LLMClient {
  chat: {
    completions: {
      create(
        params: {
          model: string;
          temperature: number;
          max_tokens: number;
          response_format?:
            | { type: 'json_object' }
            | {
                type: 'json_schema';
                json_schema: {
                  name: string;
                  schema: Record<string, unknown>;
                  strict?: boolean;
                  description?: string;
                };
              };
          /** OpenAI reasoning-model param (o-series, gpt-5), ignored by providers that don't support it */
          reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
          messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
        },
        options: { signal: AbortSignal },
      ): Promise<{
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      }>;
    };
  };
}
