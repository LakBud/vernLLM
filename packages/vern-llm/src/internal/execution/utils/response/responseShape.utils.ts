import { LLMError } from '../../../../types/errors.js';
import { parseWireToolCalls } from '../wire.utils.js';

import type { Logger } from '../../../../logger.js';
import type {
  CallParams,
  CallWithToolsResult,
  ToolIssue,
  WireToolCall,
} from '../../../../types/index.js';

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
 * Checks each `ToolCall` against the offered tools, then runs each `argumentsSchema`. Unknown names
 * and duplicate ids are collected into one `validation` error with every issue, since retrying
 * can't fix them. A schema failure keeps its own single error. Returns the calls with `arguments`
 * replaced by the schema output; the input is left untouched.
 */
export function validateToolCallArguments<
  Call extends { id: string; name: string; arguments: unknown },
>(toolCalls: Call[], tools: NonNullable<CallParams<unknown>['tools']>): Call[] {
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

  return toolCalls.map((call) => {
    const definition = known.get(call.name);

    if (!definition?.argumentsSchema) return call;

    const result = definition.argumentsSchema.safeParse(call.arguments);

    if (!result.success) {
      throw new LLMError(`Arguments for tool call "${call.name}" failed validation`, 'validation', {
        issues: result.error,
      });
    }

    return { ...call, arguments: result.data };
  });
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
 * Shapes a complete response into `T` or a `CallWithToolsResult<T>`, for streaming too once the
 * stream is buffered. Throws on an empty response, a tool contract violation, or a JSON or schema
 * failure. Reporting happens a layer up.
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

  // wireToolCalls is guaranteed to have at least one entry whenever content
  // is falsy: the throw above only lets us reach this line when content ||
  // wireToolCalls?.length is true (De Morgan's law on that guard), so if
  // content is falsy, wireToolCalls?.length must be truthy.
  const debugOutput = redactText(content ?? `[${wireToolCalls!.length} tool call(s)]`);
  const truncated = debugOutput.length > 800;

  logger.debug(
    `[VernLLM:${requestId}] output:\n` +
      debugOutput.slice(0, 800) +
      (truncated ? `... (truncated, ${debugOutput.length} chars total)` : ''),
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
      // Returning tool calls under `toolChoice: 'none'` would break the `ContentResult<T>` type
      // guarantee. The same request repeats it, so it is a non-retryable contract violation.
      throw new LLMError("Provider returned tool_calls despite toolChoice: 'none'.", 'validation', {
        code: 'tool_choice_none_violated',
      });
    }

    const toolCalls = validateToolCallArguments(
      parseWireToolCalls(wireToolCalls),
      callParams.tools,
    );

    return { type: 'tool_calls', toolCalls, ...(content ? { content } : {}) };
  }

  // No tool_calls here, so content must be present: the empty-response
  // guard above throws unless content is truthy when wireToolCalls is
  // empty, so the `?? ''` fallback here is defensive only.
  /* v8 ignore next */
  const textContent = content ?? '';

  if (!useJson) {
    return callParams.tools ? { type: 'content', content: textContent as T } : (textContent as T);
  }

  const result = parseAndValidate<T>(textContent, callParams.schema, parseJson);

  return callParams.tools ? { type: 'content', content: result } : result;
}
