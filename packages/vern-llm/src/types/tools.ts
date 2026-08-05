import type { SchemaLike } from './schema.js';

/**
 * Describes a capability the model may request — not the capability
 * itself. VernLLM transports this to the provider and parses what comes
 * back; it never executes anything.
 */
export interface ToolDefinition {
  name: string;
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
   */
  argumentsSchema?: SchemaLike<unknown>;
}

/** A single tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments (and validated, if `argumentsSchema` was set). */
  arguments: unknown;
}

/** The application's result of executing a `ToolCall`, sent back to the model. */
export interface ToolResult {
  toolCallId: string;
  content: unknown;
  /**
   * Signals a failed tool execution back to the model (matches Anthropic's
   * native `is_error` on tool_result blocks). Only `fromAnthropic` honors
   * this today — Gemini and Bedrock have no equivalent wire concept, so
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
export interface ToolCallResult {
  type: 'tool_calls';
  toolCalls: ToolCall[];
  /** Any text the model produced alongside the tool request, if present. */
  content?: string;
}

export type CallWithToolsResult<T> = ContentResult<T> | ToolCallResult;

/**
 * Runtime-safe check for whether a `call()` result is a `tool_calls`
 * result. Prefer this over relying on TypeScript's static narrowing
 * whenever `params` passed to `call()` wasn't a literal with `tools`
 * inlined (see the "note on the overload" in `VernLLM.call`'s docs) — in
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
