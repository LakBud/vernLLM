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
   * Optional client-side validator run on the parsed `arguments` before
   * they're handed back to the caller, mirroring the `schema: SchemaLike<T>`
   * pattern already used for response validation (see `types/schema.ts`).
   * Reuses that zero-dependency, `safeParse`-compatible shape instead of
   * requiring a JSON Schema validator (e.g. ajv) as a new dependency.
   * Failed validation throws `LLMError('validation')`. If omitted, VernLLM
   * parses arguments as JSON but does not validate them further.
   *
   * When set, `Args` (and therefore `Name`) flow into the `ToolCall`s
   * returned by `call()`/`cachedCall()`, provided the tool was declared
   * with `defineTool()` or otherwise has a literal `name`; see
   * `defineTool()` below for why a plain object literal often doesn't.
   */
  argumentsSchema?: SchemaLike<Args>;
}

/**
 * Preserves a tool definition's literal `name` (and its `argumentsSchema`'s
 * inferred `Args`) so it can discriminate a `ToolCall` union later.
 *
 * A plain object literal like `{ name: 'get_weather', ... }` widens `name`
 * to `string` unless annotated `as const`, which silently defeats
 * `ToolCall` narrowing the moment a second tool is added to the same
 * `tools: [...]` array (single-tool arrays still narrow fine even without
 * this, since there's nothing to discriminate against — but that stops
 * being true as soon as a second tool shows up). Wrapping the same object
 * in `defineTool()` preserves the literal `name` type without requiring
 * `as const` at every call site.
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
 * A single tool invocation requested by the model.
 *
 * When `Tools` is a literal tuple (e.g. inferred from `tools: [getWeather,
 * cancelOrder]` at a `call()`/`cachedCall()` site), this is a discriminated
 * union keyed by `name` — checking `call.name === 'get_weather'` narrows
 * `call.arguments` to that tool's `Args` with no cast needed. Without a
 * literal `Tools` (the default), this collapses back to today's
 * `{ id: string; name: string; arguments: unknown }`.
 */
export type ToolCall<Tools extends readonly ToolDefinition[] = ToolDefinition[]> = ToolCallFor<
  Tools[number]
>;

/** The application's result of executing a `ToolCall`, sent back to the model. */
export interface ToolResult {
  toolCallId: string;
  content: unknown;
  /**
   * Signals a failed tool execution back to the model (matches Anthropic's
   * native `is_error` on tool_result blocks). Only `fromAnthropic` honors
   * this today, Gemini and Bedrock have no equivalent wire concept, so
   * other adapters ignore it silently.
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
}

export type CallWithToolsResult<T, Tools extends readonly ToolDefinition[] = ToolDefinition[]> =
  | ContentResult<T>
  | ToolCallResult<Tools>;

/**
 * Runtime-safe check for whether a `call()` result is a `tool_calls`
 * result. Prefer this over relying on TypeScript's static narrowing
 * whenever `params` passed to `call()` wasn't a literal with `tools`
 * inlined (see the "note on the overload" in `VernLLM.call`'s docs), in
 * that case TS may have typed the result as plain `T` even though it's
 * actually a `CallWithToolsResult<T>` at runtime, and this check works
 * either way.
 */
export function isToolCallResult(result: unknown): result is ToolCallResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    'type' in result &&
    (result as { type: unknown }).type === 'tool_calls' &&
    Array.isArray((result as { toolCalls?: unknown }).toolCalls)
  );
}

/** What the model should do about tools on a given call. */
export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };
