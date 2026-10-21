import { LLMError, type WireCallRequest } from 'vern-llm';

import { matchesCapability, type ModelCapabilityOverride } from './capabilities.js';

/**
 * Converts between `reasoningEffort` tiers and `budgetTokens`. The numbers
 * are a guess, not a provider guarantee, and `reasoningEffortTokens`
 * overrides them.
 */
export type EffortTokenTable = Record<'minimal' | 'low' | 'medium' | 'high', number>;

type EffortTier = keyof EffortTokenTable;

const DEFAULT_EFFORT_TOKENS: EffortTokenTable = {
  minimal: 1024,
  low: 4096,
  medium: 16000,
  high: 32000,
};

/**
 * Merges a partial override over the defaults. Throws
 * `LLMError('invalid_params')` unless the tiers stay strictly ascending,
 * since `budgetTokensToEffort` walks them in order and an unordered table
 * would silently make some tiers unreachable.
 */
export function resolveEffortTokenTable(override?: Partial<EffortTokenTable>): EffortTokenTable {
  if (!override) return DEFAULT_EFFORT_TOKENS;

  const table = { ...DEFAULT_EFFORT_TOKENS, ...override };

  if (!(table.minimal < table.low && table.low < table.medium && table.medium < table.high)) {
    throw new LLMError(
      `reasoningEffortTokens must keep tiers in strictly ascending order ` +
        `(minimal < low < medium < high), got ${JSON.stringify(table)}. An out-of-order ` +
        `override doesn't just misrank tiers, it can make some of them unreachable.`,
      'invalid_params',
    );
  }

  return table;
}

/**
 * Converts `budgetTokens` into a tier. A value between two tiers rounds up
 * to the first tier it is `<=`, so this agrees with the table at its boundaries.
 */
function budgetTokensToEffort(budgetTokens: number, table: EffortTokenTable): EffortTier {
  if (budgetTokens <= table.minimal) return 'minimal';
  if (budgetTokens <= table.low) return 'low';
  if (budgetTokens <= table.medium) return 'medium';
  return 'high';
}

/**
 * An Opus id's `[major, minor]`, or `null` for a non Opus id. Not anchored,
 * so Bedrock ids match too. An 8 digit second segment is a snapshot date,
 * as in `claude-opus-4-20250514`, not a minor version, or that model would
 * read as adaptive only.
 */
function parseOpusVersion(model: string): [major: number, minor: number] | null {
  const match = /opus-(\d+)(?:-(\d+))?/.exec(model);
  if (!match) return null;

  const minorStr = match[2];
  const minor = minorStr === undefined || minorStr.length >= 8 ? 0 : Number(minorStr);

  return [Number(match[1]), minor];
}

/**
 * Built in rule for models that reject manual `budget_tokens` thinking:
 * Opus 4.7 and later, as a version threshold, and every Claude 5 tier
 * model. A new family name needs a change here or `adaptiveOnlyModels`.
 */
function isDefaultAdaptiveOnly(model: string): boolean {
  const opusVersion = parseOpusVersion(model);

  if (opusVersion) {
    const [major, minor] = opusVersion;
    return major > 4 || (major === 4 && minor >= 7);
  }

  return ['sonnet-5', 'fable-5', 'mythos'].some((s) => model.includes(s));
}

/**
 * Whether `model` is adaptive only. The override only adds models: a false
 * positive in the built in rule needs a fix here, not a per caller workaround.
 */
function isAdaptiveOnlyModel(model: string, override?: ModelCapabilityOverride): boolean {
  if (isDefaultAdaptiveOnly(model)) return true;

  return override ? matchesCapability(model, override) : false;
}

/**
 * Claude needs `budget_tokens` of at least 1024 and below `max_tokens`, which
 * the reply shares. VernLLM's default `maxTokens` of 1000 fails this, so it
 * is checked locally instead of costing a round trip.
 */
function assertValidBudgetTokens(budgetTokens: number, maxTokens: number): void {
  if (budgetTokens < 1024) {
    throw new LLMError(
      `budgetTokens (${budgetTokens}) is below Anthropic's minimum of 1024. Raise budgetTokens, ` +
        `or use a reasoningEffort tier of 'low' or above with the default conversion table.`,
      'invalid_params',
    );
  }

  if (budgetTokens >= maxTokens) {
    throw new LLMError(
      `budgetTokens (${budgetTokens}) must be less than maxTokens (${maxTokens}); the thinking ` +
        `budget and the reply share the same max_tokens ceiling on Anthropic. Raise maxTokens, ` +
        `or lower budgetTokens/reasoningEffort.`,
      'invalid_params',
    );
  }
}

/**
 * Claude rejects any thinking alongside a `tool_choice` that forces tool use.
 * The caller passes a description of its resolved choice, or `undefined` when
 * nothing is forced, so a `jsonSchema` call that forces a tool is caught too.
 */
function assertNoForcedToolChoiceWithThinking(forcedChoiceDescription: string | undefined): void {
  if (!forcedChoiceDescription) return;

  throw new LLMError(
    `budgetTokens/reasoningEffort was set alongside ${forcedChoiceDescription}. Anthropic ` +
      'rejects thinking combined with a tool_choice that forces tool use, the model has to be ' +
      "able to reply with plain text for thinking to run. Use toolChoice: 'auto' (or omit " +
      'toolChoice) for this call, or drop budgetTokens/reasoningEffort for it.',
    'invalid_params',
  );
}

/** Claude's adaptive thinking effort levels. */
type AdaptiveEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Maps a `reasoningEffort` tier onto Claude's effort. `xhigh` and `max` aren't reachable. */
function toAdaptiveEffort(effort: EffortTier): AdaptiveEffort {
  return effort === 'minimal' ? 'low' : effort;
}

/** Claude's `thinking` for a request, plus the adaptive effort when it has one. */
export interface ClaudeThinking {
  thinking: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' };
  effort?: AdaptiveEffort;
}

/**
 * Resolves `budgetTokens` and `reasoningEffort` into Claude's thinking, or
 * `undefined` when neither is set. Adaptive only models reject
 * `budget_tokens`, so they get adaptive thinking with an effort converted
 * from whatever the caller set. `forcedChoice` describes the resolved forced
 * `tool_choice`, if any, since Claude rejects thinking with one.
 */
export function resolveClaudeThinking(
  params: WireCallRequest,
  forcedChoice: string | undefined,
  options: { adaptiveOnlyModels?: ModelCapabilityOverride; effortTokenTable: EffortTokenTable },
): ClaudeThinking | undefined {
  if (params.budget_tokens === undefined && params.reasoning_effort === undefined) {
    return undefined;
  }

  assertNoForcedToolChoiceWithThinking(forcedChoice);

  if (!isAdaptiveOnlyModel(params.model, options.adaptiveOnlyModels)) {
    const budgetTokens = params.budget_tokens ?? options.effortTokenTable[params.reasoning_effort!];

    assertValidBudgetTokens(budgetTokens, params.max_tokens);

    return { thinking: { type: 'enabled', budget_tokens: budgetTokens } };
  }

  const effortTier =
    params.reasoning_effort ??
    budgetTokensToEffort(params.budget_tokens!, options.effortTokenTable);

  return { thinking: { type: 'adaptive' }, effort: toAdaptiveEffort(effortTier) };
}
