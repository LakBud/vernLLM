import { LLMError } from '../../types/errors.js';

import type { ModelCapabilityOverride } from './nativeStructuredOutput.js';

/**
 * Converts between `reasoningEffort` tiers and `budgetTokens`, for a
 * provider that only understands the other one. The numbers are a guess,
 * not a provider guarantee, and each adapter's `reasoningEffortTokens`
 * overrides them.
 */
export type EffortTokenTable = Record<'minimal' | 'low' | 'medium' | 'high', number>;

export const DEFAULT_EFFORT_TOKENS: EffortTokenTable = {
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

/** Converts a `reasoningEffort` tier into the nearest `budgetTokens` value. */
export function effortToBudgetTokens(
  effort: 'minimal' | 'low' | 'medium' | 'high',
  table: EffortTokenTable = DEFAULT_EFFORT_TOKENS,
): number {
  return table[effort];
}

/**
 * Converts `budgetTokens` into a tier. A value between two tiers rounds up
 * to the first tier it is `<=`, so this agrees with `effortToBudgetTokens`
 * at the boundaries given the same table.
 */
export function budgetTokensToEffort(
  budgetTokens: number,
  table: EffortTokenTable = DEFAULT_EFFORT_TOKENS,
): 'minimal' | 'low' | 'medium' | 'high' {
  if (budgetTokens <= table.minimal) return 'minimal';
  if (budgetTokens <= table.low) return 'low';
  if (budgetTokens <= table.medium) return 'medium';
  return 'high';
}

/**
 * An Opus id's `[major, minor]`, or `null` for a non-Opus id. Not anchored,
 * so Bedrock ids match too. An 8 digit second segment is a snapshot date,
 * as in `claude-opus-4-20250514`, not a minor version, or that model would
 * read as adaptive-only.
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
 * Whether `model` is adaptive-only. The override only adds models: a false
 * positive in the built in rule needs a fix here, not a per-caller workaround.
 */
export function isAdaptiveOnlyModel(model: string, override?: ModelCapabilityOverride): boolean {
  if (isDefaultAdaptiveOnly(model)) return true;
  if (!override) return false;

  return Array.isArray(override) ? override.includes(model) : override(model);
}

/** Whether `model` is known to support manual, budget-based thinking. */
export function supportsManualThinkingBudget(
  model: string,
  override?: ModelCapabilityOverride,
): boolean {
  return !isAdaptiveOnlyModel(model, override);
}

/**
 * Claude needs `budget_tokens` of at least 1024 and below `max_tokens`,
 * which the reply shares. VernLLM's default `maxTokens` of 1000 fails this,
 * so it is checked locally instead of costing a round trip.
 */
export function assertValidClaudeBudgetTokens(budgetTokens: number, maxTokens: number): void {
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
 * Claude rejects any thinking alongside a `tool_choice` that forces tool
 * use. Adapters pass a description of their resolved choice, or `undefined`
 * when nothing is forced, so a `jsonSchema` call that forces a tool is
 * caught too, and neither wire shape leaks in here.
 */
export function assertNoForcedToolChoiceWithThinking(
  forcedChoiceDescription: string | undefined,
): void {
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
export type ClaudeAdaptiveEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Maps a `reasoningEffort` tier onto Claude's effort. `xhigh` and `max` aren't reachable. */
export function toClaudeAdaptiveEffort(
  effort: 'minimal' | 'low' | 'medium' | 'high',
): ClaudeAdaptiveEffort {
  return effort === 'minimal' ? 'low' : effort;
}

/** Gemini 3's `thinkingLevel`, one level per `reasoningEffort` tier. */
export type GeminiThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';

/** Converts VernLLM's `reasoningEffort` directly into Gemini's `ThinkingLevel` enum value. */
export function toGeminiThinkingLevel(
  effort: 'minimal' | 'low' | 'medium' | 'high',
  model: string,
): GeminiThinkingLevel {
  return clampGeminiThinkingLevel(model, effort.toUpperCase() as GeminiThinkingLevel);
}

/** A Gemini id's minor version, `0` when it has none. */
function parseGeminiMinorVersion(model: string): number {
  const match = /gemini-\d+\.(\d+)/.exec(model);
  return match ? Number(match[1]) : 0;
}

/**
 * Gemini 3 Pro tier models reject some levels with a 400: Gemini 3 Pro
 * takes only LOW and HIGH, Gemini 3.1 Pro and later no MINIMAL. Clamped
 * rather than left to fail, since the tier is per call and the failure
 * would look intermittent. Best effort: a later release may change this.
 */
function clampGeminiThinkingLevel(model: string, level: GeminiThinkingLevel): GeminiThinkingLevel {
  if (!model.includes('pro')) return level;

  const major = parseGeminiMajorVersion(model);
  if (major === null || major < 3) return level;

  const minor = parseGeminiMinorVersion(model);

  if (minor === 0) {
    // Gemini 3 Pro: only LOW and HIGH are accepted.
    return level === 'HIGH' ? 'HIGH' : 'LOW';
  }

  // Gemini 3.1 Pro and later: LOW/MEDIUM/HIGH accepted, no MINIMAL.
  return level === 'MINIMAL' ? 'LOW' : level;
}

/** A Gemini id's major version, or `null` for a non-Gemini id. Not anchored, so prefixed ids match. */
function parseGeminiMajorVersion(model: string): number | null {
  const match = /gemini-(\d+)/.exec(model);
  return match ? Number(match[1]) : null;
}

/** Built in rule for `thinkingLevel`: Gemini 3 and later, as a version threshold. */
function isDefaultThinkingLevelModel(model: string): boolean {
  const major = parseGeminiMajorVersion(model);
  return major !== null && major >= 3;
}

/** Whether `model` uses `thinkingLevel`. The override only adds models. */
export function usesGeminiThinkingLevel(
  model: string,
  override?: ModelCapabilityOverride,
): boolean {
  if (isDefaultThinkingLevelModel(model)) return true;
  if (!override) return false;

  return Array.isArray(override) ? override.includes(model) : override(model);
}
