import type { JsonSchemaSpec, SchemaLike } from './schema.js';
import type { RefundUsage, ReserveUsage } from './usage.js';

/** A single prior turn in a multi-turn conversation, passed via `history`. */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CallParams<T = unknown> {
  systemPrompt?: string;
  userContent: string;
  /**
   * Prior turns in the conversation, oldest first, NOT including the current
   * `userContent` (that's appended automatically as the final user turn).
   * Passed straight through to the provider so follow-up questions have
   * access to earlier context. Must strictly alternate user/assistant and
   * end on an assistant turn; validated up front and rejected with an
   * LLMError('validation') before any request is made if malformed.
   */
  history?: ConversationTurn[];
  temperature?: number;
  jsonMode?: boolean;
  maxTokens?: number;
  requestId?: string;
  signal?: AbortSignal;
  /** Overrides the model set on the VernLLM instance for this call only */
  model?: string;
  /**
   * OpenAI-style reasoning effort for reasoning models (o-series, gpt-5, etc).
   * Passed through as-is, providers/models that don't support it ignore it
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /**
   * Provider-native JSON Schema structured-output mode. When set, this is sent
   * as `response_format: { type: 'json_schema', json_schema: ... }` instead of
   * the looser `json_object` mode, constraining the models output shape at
   * generation time (not just validating it after the fact). Implies jsonMode: true.
   */
  jsonSchema?: JsonSchemaSpec;
  /**
   * Optional Zod (or Zod-compatible) schema. When provided, the parsed JSON
   * is validated against it; on failure an LLMError('validation') is thrown
   * with `.issues` set to the schema's error object. Implies jsonMode: true.
   * Can be combined with `jsonSchema` for provider-level constraint + client-side typing.
   */
  schema?: SchemaLike<T>;
}

export interface CachedCallParams<T> {
  cacheKey: string;
  ttl: number;
  fn: () => Promise<T>;
  reserveUsage?: ReserveUsage;
  refundUsage?: RefundUsage;
}
