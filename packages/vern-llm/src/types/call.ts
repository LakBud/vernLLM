import type { JsonSchemaSpec, SchemaLike } from './schema.js';
import type { RefundUsage, ReserveUsage } from './usage.js';

/** A single prior turn in a multi-turn conversation, passed via `history`. */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** A plain text segment of a multimodal `userContent` array. */
export interface TextBlock {
  type: 'text';
  text: string;
}

/**
 * An inline image segment of a multimodal `userContent` array.
 *
 * `data` is the raw base64-encoded image bytes, with no `data:` URL prefix
 * (adapters that need a data URL, e.g. OpenAI-compatible `image_url`, build
 * it themselves from `mimeType` + `data`; adapters that need raw bytes, e.g.
 * Bedrock, decode the base64 themselves).
 */
export interface ImageBlock {
  type: 'image';
  /** Base64-encoded image bytes, no `data:` prefix */
  data: string;
  /** e.g. 'image/png', 'image/jpeg', 'image/webp', 'image/gif' */
  mimeType: string;
}

/** A single segment of multimodal `userContent`. */
export type ContentBlock = TextBlock | ImageBlock;

export interface CallParams<T = unknown> {
  systemPrompt?: string;

  /** Current user message, as text or multimodal content blocks. */
  userContent: string | ContentBlock[];

  /**
   * Previous conversation turns. Must alternate user/assistant and end with
   * an assistant turn; invalid history throws LLMError('validation').
   */
  history?: ConversationTurn[];

  temperature?: number;
  jsonMode?: boolean;
  maxTokens?: number;
  requestId?: string;
  signal?: AbortSignal;

  /** Overrides the instance model for this call. */
  model?: string;

  /** Reasoning effort for supported reasoning models. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';

  /**
   * Provider-native JSON Schema output constraint. Implies jsonMode: true.
   */
  jsonSchema?: JsonSchemaSpec;

  /**
   * Validates parsed JSON output. Failure throws LLMError('validation').
   * Implies jsonMode: true.
   */
  schema?: SchemaLike<T>;

  /**
   * Reserves usage before the request. Failures become
   * LLMError('quota_exceeded').
   */
  reserveUsage?: ReserveUsage;

  /**
   * Refunds usage after a failed call if reservation succeeded.
   */
  refundUsage?: RefundUsage;
}

export interface CachedCallParams<T> {
  cacheKey: string;
  ttl: number;
  fn: () => Promise<T>;
  reserveUsage?: ReserveUsage;
  refundUsage?: RefundUsage;
  signal?: AbortSignal;
}
