import { LLMError } from '../../types/errors.js';
import { toWireTools, toWireToolCalls } from './wire.utils.js';

import type {
  CallParams,
  ConversationTurn,
  WireMessage,
  WireToolChoice,
} from '../../types/index.js';

/** Everything `RequestBuilder` needs beyond a single call's own `CallParams`. */
export interface RequestBuilderOptions {
  model: string;
  defaultMaxTokens: number;
  defaultTemperature: number | null;
}

/**
 * Builds the wire request object for one call, applying per-instance
 * defaults (model, max tokens, temperature) and per-call overrides.
 * Owns every check that depends only on the caller's own input shape, not
 * on execution: history alternation, duplicate/empty tool lists,
 * `toolChoice` naming a real tool. All deterministic on the call site's
 * own input and never touch the network, so every throw here is
 * `type: 'invalid_params'`, not `'validation'` (which is reserved for the
 * model/provider's own response failing a contract check). Has no
 * knowledge of retry, timeouts, or the breaker, only
 * the three defaults a `FallbackTarget` can override per-target (see the
 * `defaultMaxTokens`/`defaultTemperature` overrides in the fallback
 * design), which is what keeps it separable from `CallExecutor`.
 */
export class RequestBuilder {
  private readonly model: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultTemperature: number | null;

  constructor(options: RequestBuilderOptions) {
    this.model = options.model;
    this.defaultMaxTokens = options.defaultMaxTokens;
    this.defaultTemperature = options.defaultTemperature;
  }

  /** Applies per-call defaults and shapes params into the client's request object. */
  build<T>(params: CallParams<T>) {
    const {
      systemPrompt,
      userContent,
      history = [],
      maxTokens = this.defaultMaxTokens,
      model = this.model,
      reasoningEffort,
      jsonSchema,
      tools,
      toolChoice,
    } = params;

    const temperature =
      params.temperature === undefined ? this.defaultTemperature : params.temperature;

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

    // Defaults to false when tools are set and the caller didn't say otherwise,
    // since forcing a JSON response format alongside tool calling is unreliable
    // across providers.
    const jsonMode = params.jsonMode ?? (tools ? false : true);
    const useJson = jsonMode || Boolean(jsonSchema);

    if (params.schema && !useJson) {
      throw new LLMError(
        'schema was provided but jsonMode: false disables JSON parsing, so nothing would validate it. Remove jsonMode: false, set jsonSchema, or remove schema.',
        'invalid_params',
      );
    }

    const responseFormat = this.buildResponseFormat(jsonSchema, useJson);

    this.validateHistory(history);

    const request = {
      model,
      ...(temperature !== null ? { temperature } : {}),
      max_tokens: maxTokens,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(tools ? { tools: toWireTools(tools) } : {}),
      ...(tools ? { tool_choice: this.buildWireToolChoice(toolChoice) } : {}),
      messages: [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        ...history.flatMap((turn): WireMessage[] => this.turnToWireMessages(turn)),
        { role: 'user' as const, content: userContent },
      ] satisfies WireMessage[],
    };

    return { useJson, model, request };
  }

  /**
   * Validates `history` alternates user/assistant turns, since providers
   * like Anthropic/Gemini reject or mishandle consecutive same-role turns.
   */
  private validateHistory(history: ConversationTurn[]): void {
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

  /** Maps VernLLM's app-facing `ToolChoice` onto the OpenAI-shaped wire `tool_choice`. */
  private buildWireToolChoice(toolChoice: CallParams<unknown>['toolChoice']): WireToolChoice {
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
  private turnToWireMessages(turn: ConversationTurn): WireMessage[] {
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
          ...(turn.content ? { content: turn.content } : {}),
          tool_calls: toWireToolCalls(turn.toolCalls),
        },
      ];
    }

    return [{ role: turn.role as 'user' | 'assistant', content: turn.content ?? '' }];
  }

  /**
   * Chooses the response format: a provider-native `jsonSchema` takes
   * priority when supplied (constrains generation directly), otherwise
   * falls back to the looser `json_object` mode when JSON output is
   * requested, or no format at all for plain text responses.
   */
  private buildResponseFormat(jsonSchema: CallParams<unknown>['jsonSchema'], useJson: boolean) {
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
}
