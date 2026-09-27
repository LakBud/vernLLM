import {
  buildResponseFormat,
  buildWireToolChoice,
  resolveJsonMode,
  turnToWireMessages,
  validateHistory,
  validateTools,
} from './utils/request/requestShape.utils.js';
import { toWireTools } from './utils/wire.utils.js';

import type { CallParams, WireMessage } from '../../types/index.js';

/** Everything `RequestBuilder` needs beyond a single call's own `CallParams`. */
export interface RequestBuilderOptions {
  model: string;
  defaultMaxTokens: number;
  defaultTemperature: number | null;
  defaultReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  defaultBudgetTokens?: number;
  /**
   * Whether the target client honors `response_format: { type: 'json_object' }`
   * as a real constraint (see `LLMClient.supportsJsonObjectMode`'s docs).
   * `true` for every built-in adapter except `fromAnthropic`/`fromBedrock`.
   */
  supportsJsonObjectMode: boolean;
}

/**
 * Builds the wire request for one call from the target's defaults and the call's overrides. Owns
 * every check on the caller's own input, so every throw is `invalid_params`; `validation` is kept
 * for provider responses. The checks themselves live in `requestShape.utils.ts`.
 */
export class RequestBuilder {
  private readonly model: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultTemperature: number | null;
  private readonly defaultReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  private readonly defaultBudgetTokens?: number;
  private readonly supportsJsonObjectMode: boolean;

  constructor(options: RequestBuilderOptions) {
    this.model = options.model;
    this.defaultMaxTokens = options.defaultMaxTokens;
    this.defaultTemperature = options.defaultTemperature;
    this.defaultReasoningEffort = options.defaultReasoningEffort;
    this.defaultBudgetTokens = options.defaultBudgetTokens;
    this.supportsJsonObjectMode = options.supportsJsonObjectMode;
  }

  /** Applies per-call defaults and shapes params into the client's request object. */
  build<T>(params: CallParams<T>) {
    const {
      systemPrompt,
      userContent,
      history = [],
      maxTokens = this.defaultMaxTokens,
      model = this.model,
      jsonSchema,
      tools,
      toolChoice,
    } = params;

    const temperature =
      params.temperature === undefined ? this.defaultTemperature : params.temperature;
    const reasoningEffort =
      params.reasoningEffort === undefined ? this.defaultReasoningEffort : params.reasoningEffort;
    const budgetTokens =
      params.budgetTokens === undefined ? this.defaultBudgetTokens : params.budgetTokens;

    validateTools(tools, toolChoice);

    const useJson = resolveJsonMode({
      jsonModeExplicit: params.jsonMode,
      hasTools: Boolean(tools),
      jsonSchema,
      hasSchema: Boolean(params.schema),
      supportsJsonObjectMode: this.supportsJsonObjectMode,
    });

    const responseFormat = buildResponseFormat(jsonSchema, useJson);

    validateHistory(history);

    const request = {
      model,
      ...(temperature !== null ? { temperature } : {}),
      max_tokens: maxTokens,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(budgetTokens !== undefined && budgetTokens !== null
        ? { budget_tokens: budgetTokens }
        : {}),
      ...(tools ? { tools: toWireTools(tools) } : {}),
      ...(tools ? { tool_choice: buildWireToolChoice(toolChoice) } : {}),
      messages: [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        ...history.flatMap((turn): WireMessage[] => turnToWireMessages(turn)),
        { role: 'user' as const, content: userContent },
      ] satisfies WireMessage[],
    };

    return { useJson, model, request };
  }
}
