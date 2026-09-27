import type { ThinkingBlock } from './call.js';
import type { SchemaLike } from './schema.js';

/**
 * Describes a capability the model may request, not the capability
 * itself. VernLLM transports this to the provider and parses what comes
 * back; it never executes anything.
 */
export interface ToolDefinition<Name extends string = string, Args = unknown> {
  name: Name;
  description: string;
  /** JSON Schema for the tool's input. */
  parameters: Record<string, unknown>;
  /**
   * Validates the parsed `arguments`, using the same `safeParse` shape as `schema`. Failure throws
   * `LLMError('validation')`; on success `ToolCall.arguments` is the schema's output, defaults and
   * transforms applied. Without it, arguments are parsed as JSON only. Types flow into `ToolCall`
   * when the tool's `name` is literal, see `defineTool()`.
   */
  argumentsSchema?: SchemaLike<Args>;
}

/**
 * Keeps a tool's literal `name` and inferred `Args`, so `ToolCall` narrows by name. A plain object
 * literal widens `name` to `string` without `as const`, which breaks narrowing once a second tool
 * is added.
 */
export function defineTool<const Name extends string, Args = unknown>(
  tool: ToolDefinition<Name, Args>,
): ToolDefinition<Name, Args> {
  return tool;
}

/** Maps a single `ToolDefinition` to its matching `ToolCall` shape. */
type ToolCallFor<T> =
  T extends ToolDefinition<infer N, infer A> ? { id: string; name: N; arguments: A } : never;

/**
 * One tool call from the model. With a literal `Tools` tuple this is a union keyed by `name`, so
 * checking `name` narrows `arguments`. Otherwise `arguments` is `unknown`.
 */
export type ToolCall<Tools extends readonly ToolDefinition[] = ToolDefinition[]> = ToolCallFor<
  Tools[number]
>;

/** The application's result of executing a `ToolCall`, sent back to the model. */
export interface ToolResult {
  toolCallId: string;
  content: unknown;
  /**
   * Marks a failed tool execution. Sent as Anthropic's `is_error` and Bedrock's error status;
   * OpenAI-compatible adapters prefix the content with `Error: `; Gemini has no equivalent and
   * ignores it.
   */
  isError?: boolean;
}

/** `call()` result when `tools` was set and the model produced a normal answer. */
export interface ContentResult<T> {
  type: 'content';
  content: T;
}

/** `call()` result when `tools` was set and the model requested one or more tools. */
export interface ToolCallResult<Tools extends readonly ToolDefinition[] = ToolDefinition[]> {
  type: 'tool_calls';
  toolCalls: ToolCall<Tools>[];
  /** Any text the model produced alongside the tool request, if present. */
  content?: string;
  /**
   * Claude's reasoning blocks before this tool request, when thinking is
   * on (`fromAnthropic` and `fromBedrock`). Put them on the assistant
   * history turn with `toolCalls` so the tool loop can continue.
   */
  thinking?: ThinkingBlock[];
}

export type CallWithToolsResult<T, Tools extends readonly ToolDefinition[] = ToolDefinition[]> =
  | ContentResult<T>
  | ToolCallResult<Tools>;

/** Recovers `Tools` from a `result` already typed `ContentResult<T> | ToolCallResult<Tools>`. Falls back to `ToolDefinition[]`. */
type ExtractTools<R> =
  Extract<R, ToolCallResult<ToolDefinition[]>> extends ToolCallResult<infer Tools>
    ? Tools
    : ToolDefinition[];

/** Explicit `Tools` type argument if given, otherwise inferred via `ExtractTools`. `never` marks "unset". */
type ResolvedTools<Tools, R> = [Tools] extends [never] ? ExtractTools<R> : Tools;

/**
 * Whether a `call()` result is a tool calls result. Use it whenever `tools` was set conditionally.
 * `toolCalls[number].arguments` is typed per tool; pass `Tools` explicitly to override inference,
 * e.g. `isToolCallResult<typeof tools>(result)`.
 */
export function isToolCallResult<
  Tools extends readonly ToolDefinition[] | undefined = never,
  R = unknown,
>(result: R): result is R & ToolCallResult<NonNullable<ResolvedTools<Tools, R>>> {
  if (typeof result !== 'object' || result === null) return false;

  const candidate = result as Partial<ToolCallResult>;
  return candidate.type === 'tool_calls' && Array.isArray(candidate.toolCalls);
}

/** What the model should do about tools on a given call. */
export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };
