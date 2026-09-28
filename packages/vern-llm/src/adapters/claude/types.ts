import type { SupportedImageMimeType } from '../internal/imageFormat.js';

/** Anthropic's native per-block content shape for a message. */
export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: SupportedImageMimeType; data: string };
    }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

/** Minimal structural type for the Anthropic SDK's `messages.create` */
export interface AnthropicClient {
  messages: {
    create(
      params: {
        model: string;
        max_tokens: number;
        temperature?: number;
        system?: string;
        messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }>;
        tools?: Array<{
          name: string;
          description?: string;
          // The SDK requires the literal `type: 'object'`, narrower than
          // VernLLM's freeform schemas; see `assertObjectSchema`.
          input_schema: { type: 'object'; [key: string]: unknown };
          strict?: boolean;
        }>;
        tool_choice?:
          | { type: 'auto' }
          | { type: 'any' }
          | { type: 'none' }
          | { type: 'tool'; name: string };
        /**
         * `format` is native structured output, which takes only `type` and
         * `schema`. `effort` drives adaptive thinking.
         */
        output_config?: {
          format?: {
            type: 'json_schema';
            schema: Record<string, unknown>;
          };
          effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
        };
        /** Manual budget thinking, or adaptive thinking paired with `output_config.effort`. */
        thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' };
      },
      options: { signal: AbortSignal },
    ): Promise<{
      content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
        thinking?: string;
        signature?: string;
        data?: string;
      }>;
      stop_reason?: string | null;
      usage?: {
        input_tokens?: number;
        cache_creation_input_tokens?: number | null;
        output_tokens?: number;
        output_tokens_details?: { thinking_tokens?: number } | null;
      };
    }>;
  };
}

/** One SSE event of an Anthropic `messages.create({ stream: true })` stream. */
export type AnthropicStreamEvent =
  | {
      type: 'message_start';
      message: {
        usage?: { input_tokens?: number; cache_creation_input_tokens?: number | null };
      };
    }
  | {
      type: 'content_block_start';
      index: number;
      content_block: {
        type: string;
        id?: string;
        name?: string;
        thinking?: string;
        signature?: string;
        data?: string;
      };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'signature_delta'; signature: string };
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      usage?: {
        output_tokens?: number;
        output_tokens_details?: { thinking_tokens?: number } | null;
      };
    }
  | { type: 'message_stop' }
  // Keep-alive during long pauses, such as extended thinking.
  | { type: 'ping' };

export type AnthropicRequestBody = Parameters<AnthropicClient['messages']['create']>[0];

export type AnthropicResponse = Awaited<ReturnType<AnthropicClient['messages']['create']>>;
