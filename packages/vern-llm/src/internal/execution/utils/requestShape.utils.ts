import { LLMError } from '../../../types/errors.js';
import { toWireToolCalls } from './wire.utils.js';

import type {
  AssistantContent,
  CallParams,
  ConversationTurn,
  WireMessage,
  WireToolChoice,
} from '../../../types/index.js';

/**
 * Serializes `ConversationTurn` assistant content for the wire. Strings
 * pass through unchanged. Parsed JSON values are `JSON.stringify`'d.
 */
export function serializeAssistantContent(content: AssistantContent): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/**
 * Validates `tools`/`toolChoice` shape: rejects an empty `tools` array, a
 * duplicate tool name, a `toolChoice` set without `tools`, and a
 * `toolChoice` naming a tool that isn't in `tools`. Deterministic on its
 * own input; every throw is `invalid_params`.
 */
export function validateTools(
  tools: CallParams<unknown>['tools'],
  toolChoice: CallParams<unknown>['toolChoice'],
): void {
  if (tools && tools.length === 0) {
    throw new LLMError(
      '`tools` was an empty array. This is almost always a bug (e.g. a filtered tool list ' +
        'that ended up empty). An empty `tools` array still switches on tool-call mode ' +
        '(response shape, jsonMode default, wire format) with nothing for the model to call. ' +
        'Omit `tools` entirely for a normal call, or make sure the array is non-empty.',
      'invalid_params',
    );
  }

  if (tools) {
    const seen = new Set<string>();
    const duplicates = new Set<string>();

    for (const tool of tools) {
      if (seen.has(tool.name)) duplicates.add(tool.name);
      seen.add(tool.name);
    }

    if (duplicates.size) {
      throw new LLMError(
        `\`tools\` has duplicate name(s): [${[...duplicates].join(', ')}]. Tool names must be unique.`,
        'invalid_params',
        { code: 'duplicate_tool_names', issues: { names: [...duplicates] } },
      );
    }
  }

  if (toolChoice && !tools) {
    throw new LLMError(
      '`toolChoice` was set without `tools`. There is nothing for it to choose between. ' +
        'Set `tools`, or remove `toolChoice`.',
      'invalid_params',
    );
  }

  if (tools && typeof toolChoice === 'object' && !tools.some((t) => t.name === toolChoice.name)) {
    throw new LLMError(
      `toolChoice names "${toolChoice.name}", which is not in \`tools\` ([${tools.map((t) => t.name).join(', ')}]).`,
      'invalid_params',
      {
        code: 'unknown_tool_choice',
        issues: { requested: toolChoice.name, available: tools.map((t) => t.name) },
      },
    );
  }
}

/** Everything `resolveJsonMode` needs to decide `useJson` for one call. */
export interface ResolveJsonModeParams {
  /** `params.jsonMode` as the caller set it, `undefined` if they didn't. */
  jsonModeExplicit: boolean | undefined;
  /** Whether `tools` was set, since the default `jsonMode` depends on it. */
  hasTools: boolean;
  jsonSchema: CallParams<unknown>['jsonSchema'];
  /** Whether `schema` was set. */
  hasSchema: boolean;
  supportsJsonObjectMode: boolean;
}

/**
 * Resolves whether this call should request and parse JSON output.
 * Defaults `jsonMode` to `false` when `tools` is set (forcing a JSON
 * response format alongside tool calling is unreliable across
 * providers), otherwise `true`. A client that can't honor
 * `response_format: 'json_object'` as a real constraint
 * (`supportsJsonObjectMode: false`, currently `fromAnthropic`/
 * `fromBedrock`) throws on an *explicit* `jsonMode: true` or a `schema`
 * with no `jsonSchema` to satisfy it, since staying silent would be worse
 * than the plain-text fallback; a *default* `jsonMode` with neither is
 * silently downgraded to plain text instead, which is what keeps
 * `llm.call({ userContent })` working out of the box on those two
 * adapters. Throws `invalid_params` if `schema` was provided but the
 * resolved mode ends up not requesting JSON at all.
 */
export function resolveJsonMode(params: ResolveJsonModeParams): boolean {
  const { jsonModeExplicit, hasTools, jsonSchema, hasSchema, supportsJsonObjectMode } = params;

  const jsonMode = jsonModeExplicit ?? !hasTools;

  if (!supportsJsonObjectMode && !jsonSchema && jsonModeExplicit === true) {
    throw new LLMError(
      'jsonMode: true was set explicitly, but this client does not support ' +
        '`response_format: "json_object"` (see LLMClient.supportsJsonObjectMode). Neither ' +
        'Anthropic nor Bedrock has a field that mechanically guarantees JSON output for this ' +
        'mode. Use `jsonSchema` instead, which maps to a real constraint on both.',
      'invalid_params',
    );
  }

  if (!supportsJsonObjectMode && !jsonSchema && jsonModeExplicit === undefined && hasSchema) {
    throw new LLMError(
      '`schema` was provided, which requires JSON output to validate against, but this client ' +
        'does not support `response_format: "json_object"` (see LLMClient.supportsJsonObjectMode) ' +
        'and no `jsonSchema` was set. Neither Anthropic nor Bedrock has a field that mechanically ' +
        'guarantees JSON output without one. Use `jsonSchema` instead, which maps to a real ' +
        'constraint on both and still runs `schema` against its parsed result.',
      'invalid_params',
    );
  }

  // A *default* (unset) `jsonMode` with no `schema` to satisfy, which
  // resolves to `true` on every plain call with no `tools`, is silently
  // downgraded to plain text instead of throwing: this is what keeps
  // `llm.call({ userContent })` working out of the box on
  // Anthropic/Bedrock exactly as it did before `json_object` support was
  // removed from those two adapters, for anyone not relying on JSON
  // output they never actually asked for.
  const jsonModeEffective =
    !supportsJsonObjectMode && !jsonSchema && jsonModeExplicit === undefined ? false : jsonMode;

  const useJson = jsonModeEffective || Boolean(jsonSchema);

  if (hasSchema && !useJson) {
    throw new LLMError(
      'schema was provided but jsonMode: false disables JSON parsing, so nothing would validate it. Remove jsonMode: false, set jsonSchema, or remove schema.',
      'invalid_params',
    );
  }

  return useJson;
}

/**
 * Chooses the response format: a provider-native `jsonSchema` takes
 * priority when supplied (constrains generation directly), otherwise
 * falls back to the looser `json_object` mode when JSON output is
 * requested, or no format at all for plain text responses.
 */
export function buildResponseFormat(
  jsonSchema: CallParams<unknown>['jsonSchema'],
  useJson: boolean,
) {
  if (jsonSchema) {
    return {
      type: 'json_schema' as const,
      json_schema: {
        name: jsonSchema.name,
        schema: jsonSchema.schema,
        strict: jsonSchema.strict ?? true,
        description: jsonSchema.description,
      },
    };
  }

  return useJson ? { type: 'json_object' as const } : undefined;
}

/** Maps VernLLM's app-facing `ToolChoice` onto the OpenAI-shaped wire `tool_choice`. */
export function buildWireToolChoice(toolChoice: CallParams<unknown>['toolChoice']): WireToolChoice {
  if (!toolChoice || toolChoice === 'auto') return 'auto';
  if (toolChoice === 'none' || toolChoice === 'required') return toolChoice;

  return { type: 'function', function: { name: toolChoice.name } };
}

/**
 * Expands one `ConversationTurn` into one or more wire messages. Plain
 * user/assistant turns map 1:1. An assistant turn with `toolCalls` maps
 * to an assistant message carrying wire-shaped `tool_calls`. A `'tool'`
 * turn expands into one wire `tool` message per `toolResult`, since
 * OpenAI-shaped wire format wants one message per tool_call_id.
 */
export function turnToWireMessages(turn: ConversationTurn): WireMessage[] {
  if (turn.role === 'tool') {
    return (turn.toolResults ?? []).map((tr) => ({
      role: 'tool' as const,
      tool_call_id: tr.toolCallId,
      content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content ?? null),
      ...(tr.isError ? { is_error: true } : {}),
    }));
  }

  if (turn.role === 'assistant' && turn.toolCalls?.length) {
    return [
      {
        role: 'assistant' as const,
        ...(turn.content !== undefined ? { content: serializeAssistantContent(turn.content) } : {}),
        tool_calls: toWireToolCalls(turn.toolCalls),
      },
    ];
  }

  if (turn.role === 'assistant') {
    return [
      {
        role: 'assistant' as const,
        content: serializeAssistantContent(turn.content === undefined ? '' : turn.content),
      },
    ];
  }

  return [{ role: turn.role as 'user', content: turn.content ?? '' }];
}

/**
 * Validates `history` alternates user/assistant turns, since providers
 * like Anthropic/Gemini reject or mishandle consecutive same-role turns.
 */
export function validateHistory(history: ConversationTurn[]): void {
  let previousTurn: ConversationTurn | undefined;

  for (const [index, turn] of history.entries()) {
    if (turn.role === 'tool') {
      if (previousTurn?.role !== 'assistant' || !previousTurn.toolCalls?.length) {
        throw new LLMError(
          `history[${index}] is a "tool" turn, but must immediately follow an "assistant" turn that requested tools`,
          'invalid_params',
        );
      }

      if (!turn.toolResults?.length) {
        throw new LLMError(
          `history[${index}] is a "tool" turn but has no toolResults`,
          'invalid_params',
        );
      }

      const requestedIds = new Set(previousTurn.toolCalls.map((tc) => tc.id));
      const resultIds = turn.toolResults.map((tr) => tr.toolCallId);

      const unknownIds = resultIds.filter((id) => !requestedIds.has(id));

      if (unknownIds.length) {
        throw new LLMError(
          `history[${index}].toolResults references unknown toolCallId(s) [${unknownIds.join(', ')}]`,
          'invalid_params',
          { code: 'unknown_tool_result_ids', issues: { historyIndex: index, ids: unknownIds } },
        );
      }

      // Catches a duplicated toolCallId that would otherwise mask a different call's missing result.
      const seenIds = new Set<string>();
      const duplicateIds = new Set<string>();

      for (const id of resultIds) {
        if (seenIds.has(id)) duplicateIds.add(id);
        seenIds.add(id);
      }

      if (duplicateIds.size) {
        throw new LLMError(
          `history[${index}].toolResults has duplicate toolCallId(s) [${[...duplicateIds].join(', ')}]`,
          'invalid_params',
          {
            code: 'duplicate_tool_result_ids',
            issues: { historyIndex: index, ids: [...duplicateIds] },
          },
        );
      }

      const missingIds = [...requestedIds].filter((id) => !resultIds.includes(id));

      if (missingIds.length) {
        throw new LLMError(
          `history[${index}] is missing toolResults for toolCallId(s) [${missingIds.join(', ')}]`,
          'invalid_params',
          { code: 'missing_tool_results', issues: { historyIndex: index, ids: missingIds } },
        );
      }
    } else {
      if (turn.role === previousTurn?.role) {
        throw new LLMError(
          `history must alternate user/assistant turns: consecutive "${turn.role}" turns at history[${index - 1}] and history[${index}]`,
          'invalid_params',
        );
      }

      if (previousTurn?.role === 'assistant' && previousTurn.toolCalls?.length) {
        throw new LLMError(
          `history[${index}] follows an assistant tool request without tool results`,
          'invalid_params',
        );
      }
    }

    previousTurn = turn;
  }

  if (previousTurn?.role === 'assistant' && previousTurn.toolCalls?.length) {
    throw new LLMError(
      'The last entry in history is an assistant tool request without tool results',
      'invalid_params',
    );
  }

  if (previousTurn?.role === 'user') {
    throw new LLMError(
      'The last entry in history is a "user" turn, which would collide with the current userContent turn.',
      'invalid_params',
    );
  }
}
