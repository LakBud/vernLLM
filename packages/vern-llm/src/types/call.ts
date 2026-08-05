import type { JsonSchemaSpec, SchemaLike } from './schema.js';
import type {
  CallWithToolsResult,
  ToolCall,
  ToolChoice,
  ToolDefinition,
  ToolResult,
} from './tools.js';
import type { UsageHooks } from './usage.js';

/**
 * A single prior turn in a multi-turn conversation, passed via `history`.
 *
 * Supports normal user/assistant messages and tool continuations: an assistant
 * turn may include `toolCalls`, and a tool turn carries the matching
 * `toolResults`. A tool turn must immediately follow an assistant tool call
 * turn, and every requested tool call must have a result.
 */
export type ConversationTurn =
  | {
      role: 'user';
      content: string;
    }
  | {
      role: 'assistant';
      content?: string;
      toolCalls?: ToolCall[];
    }
  | {
      role: 'tool';
      toolResults: ToolResult[];
    };

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

export interface CallParams<T = unknown> extends UsageHooks {
  systemPrompt?: string;

  /** Current user message, as text or multimodal content blocks. */
  userContent: string | ContentBlock[];

  /**
   * Previous conversation turns. Must alternate roles; tool turns must follow
   * assistant tool calls. Invalid history throws LLMError('validation').
   */
  history?: ConversationTurn[];

  /**
   * Generation temperature. Default 0.2, not the provider's own default.
   * Pass `null` to omit `temperature` from the request entirely, so the
   * provider applies its own default instead.
   */
  temperature?: number | null;
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
   * Tools the model may call. When set, `call()` always returns a
   * `CallWithToolsResult<T>` discriminated union instead of `T` directly
   * (see `CallWithToolsResult`), a breaking-change point: omitting `tools`
   * keeps `call()`'s old `Promise<T>` behavior exactly.
   *
   * Mutually exclusive with `jsonSchema`/`schema`: on Anthropic and
   * Bedrock, `jsonSchema` is implemented internally as a forced single-tool
   * call, which would collide with real tools. Setting both throws
   * `LLMError('validation')`.
   */
  tools?: ToolDefinition[];

  /** Defaults to `'auto'` when `tools` is set. */
  toolChoice?: ToolChoice;
}

/**
 * Parameters for a generic cached operation.
 *
 * `cachedCall()` uses `cacheKey` to look up existing results and runs `fn`
 * only on cache misses. Concurrent misses for the same key are coalesced
 * into a single in-flight operation.
 */
export interface CachedCallParams<T> extends UsageHooks {
  cacheKey: string;
  ttl: number;
  fn: () => Promise<T>;
  signal?: AbortSignal;
}

/**
 * A `CallParams` variant where tool calling is explicitly enabled.
 *
 * Requiring `tools` to be present allows TypeScript to select the
 * tool-aware `call()` overload and return `CallWithToolsResult<T>` instead
 * of the normal `T` response type.
 */
export type ToolEnabledCallParams<T> = CallParams<T> & {
  tools: NonNullable<CallParams<T>['tools']>;
};

type CachedCallInput<T> = Omit<CachedCallParams<T>, 'fn'>;

/**
 * Parameters for a cached LLM call without tool calling.
 *
 * Combines the cache configuration with the `CallParams` passed to
 * `VernLLM.call()`. The cached value is the normal LLM response type `T`.
 */
export type CachedLLMCallParams<T> = CachedCallInput<T> & {
  call: CallParams<T>;
};

/**
 * Parameters for a cached LLM call with tool calling enabled.
 *
 * The cached value includes the full `CallWithToolsResult<T>`, meaning
 * tool requests and normal content responses are cached exactly as returned
 * by the model.
 */
export type CachedLLMToolCallParams<T> = CachedCallInput<CallWithToolsResult<T>> & {
  call: ToolEnabledCallParams<T>;
};
