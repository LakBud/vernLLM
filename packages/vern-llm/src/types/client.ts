import type { ContentBlock } from './call.js';

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
      /** Only honored by `fromAnthropic` today (maps to `tool_result.is_error`); other adapters ignore it. */
      is_error?: boolean;
    };

/** The OpenAI-shaped wire `tool_choice`. */
export type WireToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

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
        };
      }>;
    };
  };
}
