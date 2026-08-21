import type { ContentBlock } from './call.js';
import type { WireStreamChunk } from './stream.js';

/** A tool call as it appears on the wire, OpenAI's `function`-wrapped shape. */
export interface WireToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON-encoded arguments, matching every OpenAI-compatible provider's wire format. */
    arguments: string;
  };
}

/** One entry of `LLMClient`'s `messages` array, named so callers building it can annotate against it. */
export type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentBlock[] }
  | {
      role: 'assistant';
      /** Optional: an assistant turn that only requested tools has no text. */
      content?: string;
      tool_calls?: WireToolCall[];
    }
  | {
      role: 'tool';
      tool_call_id: string;
      content: string;
      /** Honored by `fromAnthropic` (maps to `tool_result.is_error`) and `fromBedrock` (maps to `toolResult.status`); other adapters ignore it. */
      is_error?: boolean;
    };

/** The OpenAI-shaped wire `tool_choice`. */
export type WireToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

/**
 * Minimal shape similar to the OpenAI SDK's chat.completions.create API,
 * `response_format.json_schema` and `reasoning_effort` are optional on the wire
 * providers that don't support them will just ignore fields they don't recognize,
 * but not every SDKs TS types accept them, hence this being a structural type
 * rather than importing the SDKs own params type
 */
export interface LLMClient {
  /**
   * Whether this client supports OpenAI's `response_format: { type:
   * 'json_object' }` as a real, API-level constraint. Defaults to `true`
   * when omitted (every OpenAI-compatible client and `fromGemini` map it to
   * a real field). `fromAnthropic` and `fromBedrock` set this to `false`:
   * neither provider has a field that mechanically guarantees JSON output
   * for this mode, so `RequestBuilder` downgrades a *default* (unset)
   * `jsonMode` to plain text for these clients instead of requesting
   * `json_object` and getting an unenforced, provider-side no-op back. An
   * *explicit* `jsonMode: true` still throws for such clients, since that's
   * a caller deliberately asking for a guarantee the client can't provide.
   */
  supportsJsonObjectMode?: boolean;

  chat: {
    completions: {
      create(
        params: {
          model: string;
          temperature?: number;
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
          /**
           * Numeric reasoning token budget, for providers with a native
           * budget field (Anthropic, Gemini). Ignored by clients that only
           * understand `reasoning_effort` tiers, use that field instead for
           * those.
           */
          budget_tokens?: number;
          /** Tools the model may call, OpenAI's `function`-wrapped shape. */
          tools?: Array<{
            type: 'function';
            function: {
              name: string;
              description: string;
              parameters: Record<string, unknown>;
            };
          }>;
          tool_choice?: WireToolChoice;
          /**
           * Wire-format messages. Breaking change for custom adapters:
           * implementations must handle tool messages and assistant tool_calls.
           * Exhaustive switches over only system/user/assistant roles may no longer compile.
           */
          messages: WireMessage[];
        },
        options: { signal: AbortSignal },
      ): Promise<{
        choices?: Array<{
          message?: { content?: string | null; tool_calls?: WireToolCall[] };
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      }>;

      /**
       * Optional. Required only for `stream: true` calls. Adapters/clients
       * that don't implement this make `stream: true` throw a clear
       * `LLMError('validation')` rather than a confusing runtime failure.
       * Takes the same request shape as `create`, minus the response type.
       */
      createStream?(
        params: Parameters<LLMClient['chat']['completions']['create']>[0],
        options: { signal: AbortSignal },
      ): AsyncIterable<WireStreamChunk>;
    };
  };
}
