import type { Logger } from '../logger.js';
import type { ContentBlock, ThinkingBlock } from './call.js';
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
      /** Reasoning blocks to send back ahead of the text and tool calls. Adapters without the concept drop it. */
      thinking?: ThinkingBlock[];
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
 * Which adapter built an `LLMClient`, and which provider it talks to.
 * Read by middleware through `AttemptContext.adapter`, so telemetry can
 * name the provider without guessing from the model id.
 */
export interface AdapterInfo {
  /** Adapter family, e.g. `'anthropic'`, `'openai-compatible'`, or `'custom'` for a client that sets none. */
  name: string;
  /**
   * The provider this client talks to, in the OpenTelemetry
   * `gen_ai.provider.name` vocabulary (`'openai'`, `'anthropic'`,
   * `'aws.bedrock'`, ...). Only set when the adapter knows it for certain.
   */
  provider?: string;
}

/**
 * The client shape adapters implement, modeled on OpenAI's `chat.completions.create`. Structural
 * rather than an SDK's own types, since not every SDK's types accept every field.
 */
export interface LLMClient {
  /**
   * Whether `response_format: 'json_object'` is really enforced. Defaults to `true`. `false` makes
   * a default `jsonMode` fall back to plain text instead of getting an unenforced no-op, while an
   * explicit `jsonMode: true` throws.
   */
  supportsJsonObjectMode?: boolean;

  /** Which adapter built this client. Every built in adapter sets it; a hand written client may leave it out. */
  adapter?: AdapterInfo;

  /**
   * Hands the client the `VernLLM` instance's logger, once per target at
   * construction, for adapter log lines. A client shared by several
   * instances keeps the last one it was given.
   */
  setLogger?(logger: Logger): void;

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
           * Numeric reasoning budget, for providers with one. Clients with only effort tiers use
           * `reasoning_effort` instead.
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
          message?: {
            content?: string | null;
            tool_calls?: WireToolCall[];
            /** Reasoning blocks the model produced, in order. Only Claude adapters report them. */
            thinking?: ThinkingBlock[];
          };
          /**
           * Why generation stopped, in OpenAI's terms. Only `'length'` is read: output that then
           * fails to parse becomes the retryable `response_truncated`. Optional.
           */
          finish_reason?: string | null;
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      }>;

      /**
       * Required only for `stream: true`, which throws a clear error without it. Takes the same
       * request as `create`.
       */
      createStream?(
        params: Parameters<LLMClient['chat']['completions']['create']>[0],
        options: { signal: AbortSignal },
      ): AsyncIterable<WireStreamChunk>;
    };
  };
}
