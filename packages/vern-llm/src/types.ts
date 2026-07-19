export type LLMErrorType =
  | 'timeout'
  | 'api'
  | 'parse'
  | 'validation'
  | 'circuit_open'
  | 'unknown'
  | 'aborted';

export class LLMError extends Error {
  constructor(
    message: string,
    public type: LLMErrorType,
    public status?: number,
    public issues?: unknown,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

export function isLLMError(err: unknown): err is LLMError {
  return err instanceof LLMError;
}

export interface CacheAdapter<T = unknown> {
  get(key: string): Promise<T | null>;
  set(key: string, value: T, ttl: number): Promise<void>;
}

/**
 * Trivial default so the package works out of the box with no external deps
 * Not shared across processes, swap in Redis/Upstash/etc for production
 */
export class InMemoryCacheAdapter<T = unknown> implements CacheAdapter<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();

  async get(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: T, ttl: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
  }
}

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
          messages: Array<{ role: 'system' | 'user'; content: string }>;
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

export type ReserveUsage = () => Promise<void>;
export type RefundUsage = () => Promise<void>;

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestId: string;
  model: string;
}

export type OnUsage = (usage: TokenUsage) => void;

/**
 * Minimal structural type for a Zod-like schema, so this package doesnt need
 * a hard dependency on a specific Zod major version. Any object exposing
 * `safeParse` (Zod v3/v4, and most Zod-compatible validators) should satisfy this
 */
export interface SchemaLike<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown };
}

export interface VernLLMOptions {
  client: LLMClient;
  model: string;
  /** Max retries after the first attempt. Default 1 (2 attempts total) */
  maxRetries?: number;
  /** Per-attempt timeout in ms. Default 25000 */
  timeoutMs?: number;
  /** Base delay for exponential backoff in ms. Default 500 */
  baseDelayMs?: number;
  /** Default max_tokens for calls that don't override it. Default 1000 */
  defaultMaxTokens?: number;
  /** Enables debug logging of raw model output. Default: NODE_ENV !== 'production' */
  debug?: boolean;
  /** Cache adapter for cachedCall. Defaults to an in-memory adapter */
  cache?: CacheAdapter;
  /** HTTP status codes that should fail fast without retrying. Default [400, 401, 403] */
  nonRetryableStatus?: number[];
  /** Custom JSON parser. Must return undefined/null on failure. Default: JSON.parse wrapped in try/catch */
  parseJson?: (content: string) => unknown;
  /** Called after every successful call with token usage, if the provider reports it */
  onUsage?: OnUsage;
  /** Injectable logger. Defaults to a console-based logger gated by `debug` */
  logger?: import('./logger.js').Logger;
  /**
   * Enables a circuit breaker that short-circuits calls after repeated
   * consecutive failures, instead of continuing to hammer a down provider
   * Pass `true` for defaults, or an options object to tune threshold/cooldown
   */
  circuitBreaker?: boolean | import('./circuitBreaker.js').CircuitBreakerOptions;
}

/**
 * A provider-native JSON Schema for structured outputs (OpenAI/Groq
 * `response_format: { type: 'json_schema' }`) This is the wire-format
 * schema the model is constrained to generate against, distinct from
 * `schema`, which is a client-side Zod validator run on the parsed result
 * You can use one, both, or neither; using both gets you provider-level
 * constraint plus client-side type inference/validation as a safety net
 */
export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
  /** Enforces the schema strictly (OpenAI-specific), default true when supported */
  strict?: boolean;
  description?: string;
}

export interface CallParams<T = unknown> {
  systemPrompt: string;
  userContent: string;
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
