import { LLMError } from '../../../types/errors.js';
import { parseWireToolCalls } from './wire.utils.js';

import type { Logger } from '../../../logger.js';
import type {
  CallParams,
  CallWithToolsResult,
  ToolIssue,
  WireToolCall,
} from '../../../types/index.js';

/** Parses response content as JSON and validates it against `schema` when supplied. */
export function parseAndValidate<T>(
  content: string,
  schema: CallParams<T>['schema'] | undefined,
  parseJson: (content: string) => unknown,
): T {
  let parsed: unknown;

  try {
    parsed = parseJson(content);
  } catch {
    throw new LLMError('Invalid JSON response', 'parse');
  }

  if (parsed === null || parsed === undefined) {
    throw new LLMError('Invalid JSON response', 'parse');
  }

  if (!schema) return parsed as T;

  const result = schema.safeParse(parsed);

  if (!result.success) {
    throw new LLMError('Schema validation failed', 'validation', { issues: result.error });
  }

  return result.data;
}

/**
 * Checks every `ToolCall` against the `tools` that were offered, catching
 * a hallucinated tool name and a duplicate call id before either reaches
 * the application's dispatch table, then runs each tool's
 * `argumentsSchema`, if present.
 *
 * Contract failures (unknown name, duplicate id) are collected across
 * every call and thrown together as one `type: 'validation'` error with
 * `issues: ToolIssue[]`, since retrying a request that already has these
 * errors cannot help (excluded from retry by `type`) and a caller fixing
 * them wants to see every one, not just the first. Schema failures keep
 * the original single-error, `type: 'validation'` shape rather than being
 * folded into the aggregate, since they're a distinct failure kind from
 * the contract failures above.
 */
export function validateToolCallArguments(
  toolCalls: { id: string; name: string; arguments: unknown }[],
  tools: NonNullable<CallParams<unknown>['tools']>,
): void {
  const known = new Map(tools.map((tool) => [tool.name, tool]));
  const seenIds = new Set<string>();
  const toolIssues: ToolIssue[] = [];

  for (const call of toolCalls) {
    if (seenIds.has(call.id)) {
      toolIssues.push({ name: call.name, toolCallId: call.id, code: 'duplicate_tool_call_id' });
    }
    seenIds.add(call.id);

    if (!known.has(call.name)) {
      toolIssues.push({ name: call.name, toolCallId: call.id, code: 'unknown_tool' });
    }
  }

  if (toolIssues.length > 0) {
    const unknownTool = toolIssues.find((issue) => issue.code === 'unknown_tool');
    const primary = unknownTool
      ? `Model requested tool "${unknownTool.name}", which was not in the tools offered ([${[...known.keys()].join(', ')}]).`
      : `Duplicate tool call id "${toolIssues[0]!.toolCallId}" in the model's response.`;

    // Most responses hit exactly one issue. When there's more than one,
    // say so, since toolCalls[0]'s problem alone would otherwise read as
    // the whole story.
    const message =
      toolIssues.length > 1
        ? `${primary} (${toolIssues.length} tool call issues total, see error.issues.)`
        : primary;

    throw new LLMError(message, 'validation', {
      code: unknownTool ? 'unknown_tool' : 'duplicate_tool_call_id',
      issues: toolIssues,
    });
  }

  for (const call of toolCalls) {
    const definition = known.get(call.name);

    if (!definition?.argumentsSchema) continue;

    const result = definition.argumentsSchema.safeParse(call.arguments);

    if (!result.success) {
      throw new LLMError(`Arguments for tool call "${call.name}" failed validation`, 'validation', {
        issues: result.error,
      });
    }
  }
}

/** Everything `shapeResponse` needs beyond the raw response itself. */
export interface ShapeResponseParams<T> {
  rawContent: string | null | undefined;
  wireToolCalls: WireToolCall[] | undefined;
  params: CallParams<T>;
  useJson: boolean;
  parseJson: (content: string) => unknown;
  requestId: string;
  logger: Pick<Logger, 'debug'>;
  redactText: (text: string) => string;
}

/**
 * Shapes a fully-arrived response (content and/or tool_calls, already
 * extracted from the provider's payload) into `T` or a
 * `CallWithToolsResult<T>`. Reused by the streaming path once it has
 * buffered the full text/tool-call deltas, so there's no separate
 * parsing/validation logic for streaming.
 *
 * Throws `LLMError` on an empty response, a tool-contract violation, or a
 * JSON/schema failure. No breaker or usage reporting here, that's
 * `finalizeResponse`'s job, one layer up.
 */
export function shapeResponse<T>(params: ShapeResponseParams<T>): T | CallWithToolsResult<T> {
  const {
    rawContent,
    wireToolCalls,
    params: callParams,
    useJson,
    parseJson,
    requestId,
    logger,
    redactText,
  } = params;

  // `.trim()` runs unguarded: a malformed response shape (e.g. a
  // non-string `content`) throws here, same as every other post-response
  // failure, and is normalized by the caller.
  const content = rawContent?.trim();

  if (!content && !wireToolCalls?.length) {
    throw new LLMError('Empty LLM response', 'api', { code: 'empty_response' });
  }

  logger.debug(
    `[VernLLM:${requestId}] output:\n` +
      redactText(content ?? `[${wireToolCalls?.length ?? 0} tool call(s)]`).slice(0, 800),
  );

  if (wireToolCalls?.length) {
    if (!callParams.tools) {
      // Same class of problem as the other tool-contract codes below:
      // a provider contract violation, not an HTTP failure, so this is
      // `type: 'validation'` rather than `'api'`. Byte-for-byte
      // identical on retry, so not retryable.
      throw new LLMError(
        'Provider returned tool_calls but no `tools` were sent with this call.',
        'validation',
        { code: 'unexpected_tool_calls' },
      );
    }

    if (callParams.toolChoice === 'none') {
      // `toolChoice: 'none'` is what lets `call()`'s type narrow to
      // `ContentResult<T>` (see `ToolsDisabledCallParams`). A
      // nonconforming provider/adapter returning tool_calls anyway
      // would silently break that guarantee for the caller, so this
      // is treated as a hard API-contract violation rather than
      // passed through as a normal tool_calls result. The request
      // itself is byte-for-byte identical on retry, so this repeats
      // deterministically like the other tool-contract failures
      // below: not retryable, and not the provider being unhealthy.
      throw new LLMError("Provider returned tool_calls despite toolChoice: 'none'.", 'validation', {
        code: 'tool_choice_none_violated',
      });
    }

    const toolCalls = parseWireToolCalls(wireToolCalls);

    validateToolCallArguments(toolCalls, callParams.tools);

    return { type: 'tool_calls', toolCalls, ...(content ? { content } : {}) };
  }

  // No tool_calls here, so content must be present.
  const textContent = content ?? '';

  if (!useJson) {
    return callParams.tools ? { type: 'content', content: textContent as T } : (textContent as T);
  }

  const result = parseAndValidate<T>(textContent, callParams.schema, parseJson);

  return callParams.tools ? { type: 'content', content: result } : result;
}
