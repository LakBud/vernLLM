import { unsupportedCapability } from '../internal/errors.js';
import { budgetTokensToEffort, type EffortTokenTable } from '../internal/reasoningBudget.utils.js';

import type { Logger } from '../../logger.js';
import type { LLMClient } from '../../types/index.js';
import type { ModelCapabilityOverride } from '../internal/nativeStructuredOutput.js';
import type { OpenAIWireReasoningEffort } from './types.js';

/**
 * Built in rule for models that only take `tools` on Chat Completions with
 * `reasoning_effort: "none"`: bare `gpt-` ids of major 6 and later, except
 * `-chat` ids. A gateway id is left alone, since the gateway decides what
 * it forwards.
 */
function isDefaultNoReasoningToolModel(model: string): boolean {
  if (/-chat/.test(model)) return false;

  const gptMajor = /^gpt-(\d+)/.exec(model)?.[1];
  return gptMajor !== undefined && Number(gptMajor) >= 6;
}

/** Whether `model` needs `reasoning_effort: "none"` to take tools. `override` replaces the built in rule. */
function needsNoReasoningForTools(model: string, override?: ModelCapabilityOverride): boolean {
  if (!override) return isDefaultNoReasoningToolModel(model);

  return Array.isArray(override) ? override.includes(model) : override(model);
}

/**
 * Whether this request must go out with `reasoning_effort: "none"`. Reasoning
 * that was asked for, an instance default included, throws instead of being
 * dropped, since dropping it would change output quality with no signal.
 */
export function requiresNoReasoning(
  params: Parameters<LLMClient['chat']['completions']['create']>[0],
  override: ModelCapabilityOverride | undefined,
): boolean {
  if (!params.tools?.length || !needsNoReasoningForTools(params.model, override)) return false;

  if (params.reasoning_effort !== undefined || params.budget_tokens !== undefined) {
    throw unsupportedCapability(
      `OpenAI model "${params.model}" only accepts tools on Chat Completions with ` +
        'reasoning_effort "none", but this call asks for reasoning through reasoningEffort or ' +
        'budgetTokens (an instance default counts). Pass reasoningEffort: null and budgetTokens: ' +
        'null for this call, or use the Responses API for reasoning with tools.',
      'tools_with_reasoning',
    );
  }

  return true;
}

/** Sets `reasoning_effort: "none"` when `apply` is true, logging it once for this request. */
export function withNoReasoning<P extends { model: string }>(
  params: P,
  apply: boolean,
  logger: Logger | undefined,
): P & { reasoning_effort?: OpenAIWireReasoningEffort } {
  if (!apply) return params;

  logger?.debug(
    `[VernLLM] ${params.model}: sending reasoning_effort "none", required for tools on Chat Completions`,
  );
  return { ...params, reasoning_effort: 'none' };
}

/**
 * OpenAI only understands `reasoning_effort`, so a lone `budget_tokens` is
 * converted to the nearest tier and dropped from the request.
 */
export function applyReasoningBudget<
  P extends { reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high'; budget_tokens?: number },
>(params: P, effortTokenTable?: EffortTokenTable): P {
  if (params.budget_tokens === undefined) return params;

  const { budget_tokens, ...rest } = params;

  return rest.reasoning_effort !== undefined
    ? (rest as P)
    : ({ ...rest, reasoning_effort: budgetTokensToEffort(budget_tokens, effortTokenTable) } as P);
}

/**
 * Whether `model` is an OpenAI reasoning model: the o-series and every GPT
 * generation from 5 on, matched as a version threshold so later generations
 * need no change. `-chat` ids are excluded, and a gateway id is left for the
 * gateway to normalize, since many providers here still expect `max_tokens`.
 */
function isOpenAIReasoningModel(model: string): boolean {
  if (/-chat/.test(model)) return false;
  if (/^o\d/.test(model)) return true;

  const gptMajor = /^gpt-(\d+)/.exec(model)?.[1];
  return gptMajor !== undefined && Number(gptMajor) >= 5;
}

/**
 * OpenAI reasoning models need `max_completion_tokens` instead of
 * `max_tokens` and reject a non-default `temperature`, which VernLLM always
 * sends, so both are rewritten.
 */
export function applyReasoningModelParams<
  P extends { model: string; max_tokens: number; temperature?: number },
>(params: P): P {
  if (!isOpenAIReasoningModel(params.model)) return params;

  const { max_tokens, temperature: _temperature, ...rest } = params;

  return { ...rest, max_completion_tokens: max_tokens } as unknown as P;
}
