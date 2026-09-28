import { LLMError, type WireCallRequest } from '../../types/index.js';
import { unsupportedCapability } from './errors.js';
import { assertForcedToolChoiceSupported, rejectsForcedToolChoice } from './forcedToolChoice.js';
import {
  supportsNativeStructuredOutput,
  type ModelCapabilityOverride,
} from './nativeStructuredOutput.js';
import {
  assertNoForcedToolChoiceWithThinking,
  assertValidClaudeBudgetTokens,
  budgetTokensToEffort,
  effortToBudgetTokens,
  supportsManualThinkingBudget,
  toClaudeAdaptiveEffort,
  type ClaudeAdaptiveEffort,
  type EffortTokenTable,
} from './reasoningBudget.utils.js';

// Claude's request rules, shared by every adapter that talks to Claude so
// each only maps the decisions onto its own wire shape.

type WireJsonSchema = Extract<
  NonNullable<WireCallRequest['response_format']>,
  { type: 'json_schema' }
>['json_schema'];

/**
 * How `jsonSchema` is sent: not at all, as native structured output, or as a
 * forced call to a tool named `schemaName`, the trimmed schema name.
 */
export type ClaudeStructuredOutputPlan =
  | { mode: 'none' }
  | { mode: 'native'; jsonSchema: WireJsonSchema; schemaName: string }
  | { mode: 'forcedTool'; jsonSchema: WireJsonSchema; schemaName: string };

/**
 * Checks `jsonSchema`, `tools` and `tool_choice` against a Claude model and
 * picks how structured output is sent. A model that rejects a forced
 * `tool_choice` can't run the forced tool emulation, so native output is its
 * only working path. Throws before dispatch for a request the model can't
 * serve; `messages` keeps each provider's wording.
 */
export function planClaudeStructuredOutput(
  provider: string,
  params: WireCallRequest,
  models: {
    nativeStructuredOutputModels?: ModelCapabilityOverride;
    forcedToolChoiceUnsupportedModels?: ModelCapabilityOverride;
  },
  messages: { toolsWithJsonSchema: (model: string) => string; jsonObject: string },
): ClaudeStructuredOutputPlan {
  const jsonSchema =
    params.response_format?.type === 'json_schema' ? params.response_format.json_schema : undefined;
  const schemaName = jsonSchema?.name.trim();

  if (jsonSchema && !schemaName) {
    throw new LLMError('json_schema.name must not be empty.', 'validation');
  }

  const rejectsForced = rejectsForcedToolChoice(
    params.model,
    models.forcedToolChoiceUnsupportedModels,
  );

  if (params.tools?.length) {
    assertForcedToolChoiceSupported(
      provider,
      params.model,
      params.tool_choice,
      models.forcedToolChoiceUnsupportedModels,
    );
  }

  const isNative =
    Boolean(jsonSchema) &&
    (rejectsForced ||
      supportsNativeStructuredOutput(params.model, models.nativeStructuredOutputModels));

  if (jsonSchema && params.tools?.length && !isNative) {
    throw unsupportedCapability(
      messages.toolsWithJsonSchema(params.model),
      'tools_with_json_schema',
    );
  }

  if (params.response_format?.type === 'json_object') {
    throw new LLMError(messages.jsonObject, 'validation');
  }

  if (!jsonSchema || !schemaName) return { mode: 'none' };
  return { mode: isNative ? 'native' : 'forcedTool', jsonSchema, schemaName };
}

/** Claude's `thinking` for a request, plus the adaptive effort when it has one. */
export interface ClaudeThinking {
  thinking: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' };
  effort?: ClaudeAdaptiveEffort;
}

/**
 * Resolves `budgetTokens` and `reasoningEffort` into Claude's thinking, or
 * `undefined` when neither is set. Adaptive-only models reject
 * `budget_tokens`, so they get adaptive thinking with an effort converted
 * from whatever the caller set. `forcedChoice` describes the resolved
 * forced `tool_choice`, if any, since Claude rejects thinking with one.
 */
export function resolveClaudeThinking(
  params: WireCallRequest,
  forcedChoice: string | undefined,
  options: { adaptiveOnlyModels?: ModelCapabilityOverride; effortTokenTable?: EffortTokenTable },
): ClaudeThinking | undefined {
  if (params.budget_tokens === undefined && params.reasoning_effort === undefined) {
    return undefined;
  }

  assertNoForcedToolChoiceWithThinking(forcedChoice);

  if (supportsManualThinkingBudget(params.model, options.adaptiveOnlyModels)) {
    const budgetTokens =
      params.budget_tokens ??
      effortToBudgetTokens(params.reasoning_effort!, options.effortTokenTable);

    assertValidClaudeBudgetTokens(budgetTokens, params.max_tokens);

    return { thinking: { type: 'enabled', budget_tokens: budgetTokens } };
  }

  const effortTier =
    params.reasoning_effort ??
    budgetTokensToEffort(params.budget_tokens!, options.effortTokenTable);

  return { thinking: { type: 'adaptive' }, effort: toClaudeAdaptiveEffort(effortTier) };
}
