import { LLMError } from '../../types/errors.js';

import type { ModelCapabilityOverride } from './nativeStructuredOutput.js';

/**
 * Shared conversion between the two reasoning controls VernLLM exposes:
 * `reasoningEffort` (a tier string, OpenAI's native shape) and
 * `budgetTokens` (a raw integer, Anthropic's and Gemini's native shape).
 *
 * Every adapter prefers its own native field when the caller set it, and
 * only calls into this table when the caller set the other one instead.
 * The numbers here are a guess, not a provider guarantee, callers who
 * need a precise budget on a specific model should set `budgetTokens`
 * directly rather than relying on this table's `reasoningEffort` mapping.
 *
 * The table itself is overridable per adapter instance, via
 * `reasoningEffortTokens` on each `from*` adapter's options (see
 * `AnthropicAdapterOptions`, `GeminiAdapterOptions`,
 * `OpenAICompatibleAdapterOptions`, `BedrockAdapterOptions`), for callers
 * who want `reasoningEffort` tiers to map onto different token counts
 * than the defaults below, e.g. a model whose useful reasoning range
 * doesn't match these numbers.
 */

export type EffortTokenTable = Record<'minimal' | 'low' | 'medium' | 'high', number>;

export const DEFAULT_EFFORT_TOKENS: EffortTokenTable = {
  minimal: 1024,
  low: 4096,
  medium: 16000,
  high: 32000,
};

/**
 * Merges a caller-supplied partial override over `DEFAULT_EFFORT_TOKENS`.
 * Called once per adapter instance (not per request), so a per-instance
 * override only needs to specify the tiers it actually wants to change.
 *
 * Throws `LLMError('invalid_params')` if the override doesn't keep the
 * tiers in strictly ascending order (`minimal < low < medium < high`).
 * `budgetTokensToEffort` buckets by walking the tiers low to high and
 * returning on the first one a value is `<=`, so an unordered table (e.g.
 * `low` above `medium`) wouldn't just produce a "wrong" bucket, it would
 * make some tiers unreachable outright, silently, with no signal to the
 * caller that their override doesn't do what they think it does.
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
 * Converts a raw `budgetTokens` value into the nearest `reasoningEffort`
 * tier, for providers that only understand tiers. Buckets by the same
 * `table` `effortToBudgetTokens` produces its values from, so the two
 * functions agree with each other at the boundary values, as long as the
 * same (possibly overridden) table is passed to both. A value strictly
 * between two tiers (e.g. 4097, one above the default `low`) rounds up to
 * the next tier it's still `<=`, i.e. `medium` here, not down to `low`.
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
 * Parses an Opus model id's generation and minor version, e.g.
 * `"claude-opus-4-7-20260101"` -> `[4, 7]`, `"anthropic.claude-opus-5-x"` ->
 * `[5, 0]`. Not anchored, so it matches equally inside a bare Anthropic id
 * or a Bedrock id carrying a provider prefix. Returns `null` for a
 * non-Opus model id.
 */
/**
 * Parses an Opus model id's generation and minor version, e.g.
 * `"claude-opus-4-7-20260101"` -> `[4, 7]`, `"anthropic.claude-opus-5-x"` ->
 * `[5, 0]`. Not anchored, so it matches equally inside a bare Anthropic id
 * or a Bedrock id carrying a provider prefix. Returns `null` for a
 * non-Opus model id.
 *
 * Anthropic model ids sometimes carry a trailing snapshot date instead of
 * (or in addition to) an explicit minor version, e.g. the real, still-
 * supported base `"claude-opus-4-20250514"` (no `.7`-style minor at all,
 * just a date suffix directly after the major version). Read naively,
 * `20250514` looks like a minor version far above any real threshold and
 * would misclassify this pre-4.6 model as adaptive-only. Snapshot dates
 * are always 8 digits (`YYYYMMDD`); a real minor version never is, so an
 * 8+ digit second segment is treated as a date, not a minor version.
 */
function parseOpusVersion(model: string): [major: number, minor: number] | null {
  const match = /opus-(\d+)(?:-(\d+))?/.exec(model);
  if (!match) return null;

  const minorStr = match[2];
  const minor = minorStr === undefined || minorStr.length >= 8 ? 0 : Number(minorStr);

  return [Number(match[1]), minor];
}

/**
 * Default rule for whether `model` only supports adaptive thinking
 * (`thinking: { type: 'adaptive' }`) and returns a 400 for manual,
 * budget-based thinking (`thinking: { type: 'enabled', budget_tokens }`):
 * Claude Opus 4.7 and later (matched as a version threshold, so 4.8, 4.9,
 * 5, and every future Opus point release are covered automatically,
 * without a new list entry per release), and every Claude 5 tier model
 * outside the Opus family (Sonnet 5, Fable 5, Mythos 5, Mythos Preview).
 * `mythos` alone is enough to catch both Mythos names without listing
 * each separately.
 *
 * Necessarily best-effort: a new model family with its own name (not
 * `opus-*`, not `sonnet-5`/`fable-5`/`mythos-*`) still needs a code
 * update here, or a caller-supplied `adaptiveOnlyModels` override (see
 * `isAdaptiveOnlyModel`) covering it in the meantime.
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
 * Whether `model` is adaptive-only, per the built-in rule above, or per a
 * caller-supplied `adaptiveOnlyModels` override. The override is
 * additive, not a replacement: it can mark an *additional* model as
 * adaptive-only (useful for a model family this package doesn't know
 * about yet), but it can't un-mark one the built-in rule already caught,
 * since a caller correcting a false negative is the only direction that
 * needs covering, a false positive here would mean this package is
 * simply wrong and needs its own fix, not a per-caller workaround.
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
 * Anthropic (and Claude models on Bedrock) require `budget_tokens` to be
 * at least 1024 and strictly less than `max_tokens`, since the thinking
 * budget and the reply share the same `max_tokens` ceiling. VernLLM's own
 * default `maxTokens` is 1000 (see `RequestBuilder`'s `defaultMaxTokens`),
 * below the 1024 floor, so the *default* `minimal` tier (1024 tokens) is
 * silently invalid against the *default* `max_tokens` unless a caller
 * happens to raise one or the other. Checked here, once, right before a
 * `thinking` block would be built, rather than left for Anthropic's own
 * 400 to explain after a real network round trip.
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
 * Anthropic's own effort levels for adaptive thinking, `output_config.effort`
 * (or Bedrock's typed `outputConfig.effort`), five tiers: `low`, `medium`,
 * `high`, `xhigh`, `max`. This is a different control than VernLLM's own
 * `reasoningEffort`/`budgetTokens`, not a token count, so it needs its own
 * mapping rather than reusing `EffortTokenTable`.
 */
export type ClaudeAdaptiveEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Maps VernLLM's four-tier `reasoningEffort` onto Anthropic's five-tier
 * adaptive effort. `xhigh` and `max` have no VernLLM-side equivalent and
 * are unreachable through this mapping; a caller who wants either has to
 * target Anthropic/Bedrock-specific behavior already, so there's no gap
 * the shared `CallParams` surface needs to cover for a first pass.
 */
export function toClaudeAdaptiveEffort(
  effort: 'minimal' | 'low' | 'medium' | 'high',
): ClaudeAdaptiveEffort {
  return effort === 'minimal' ? 'low' : effort;
}

/**
 * Gemini's own thinking-level control, `thinkingConfig.thinkingLevel`,
 * used by Gemini 3 series models instead of the numeric `thinkingBudget`
 * every earlier Gemini generation uses. Unlike Anthropic's five-tier
 * adaptive effort, this lines up exactly with VernLLM's own four-tier
 * `reasoningEffort`, so no lossy mapping table is needed, just a literal
 * case change.
 */
export type GeminiThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';

/** Converts VernLLM's `reasoningEffort` directly into Gemini's `ThinkingLevel` enum value. */
export function toGeminiThinkingLevel(
  effort: 'minimal' | 'low' | 'medium' | 'high',
): GeminiThinkingLevel {
  return effort.toUpperCase() as GeminiThinkingLevel;
}

/**
 * Parses a Gemini model id's major generation number, e.g.
 * `"gemini-3.1-flash-lite"` -> `3`, `"gemini-2.5-flash"` -> `2`. Not
 * anchored, so a Vertex-prefixed or otherwise decorated id still matches.
 * Returns `null` for a non-Gemini model id.
 */
function parseGeminiMajorVersion(model: string): number | null {
  const match = /gemini-(\d+)/.exec(model);
  return match ? Number(match[1]) : null;
}

/**
 * Default rule for whether `model` uses `thinkingLevel` instead of
 * `thinkingBudget`: every Gemini 3 series model and later, matched as a
 * version threshold so 3.1, 3.5, 3.6, and every future Gemini 3.x or
 * later release are covered automatically, without a new entry per
 * release, same reasoning as `isDefaultAdaptiveOnly`'s Opus threshold.
 * Gemini 2.5 and earlier still use `thinkingBudget`.
 *
 * `thinkingBudget` is still *accepted* on Gemini 3 for backward
 * compatibility, per Google's own docs, but "may result in unexpected
 * performance" there, so this rule switches VernLLM's own default
 * behavior over rather than leaving it on the old field indefinitely.
 */
function isDefaultThinkingLevelModel(model: string): boolean {
  const major = parseGeminiMajorVersion(model);
  return major !== null && major >= 3;
}

/**
 * Whether `model` uses `thinkingLevel`, per the built-in version
 * threshold above, or per a caller-supplied `thinkingLevelModels`
 * override. Additive, not a replacement, same reasoning as
 * `isAdaptiveOnlyModel`: an override can mark an *additional* model as
 * using `thinkingLevel` (a model family this package doesn't recognize
 * yet), it can't un-mark one the built-in threshold already caught.
 */
export function usesGeminiThinkingLevel(
  model: string,
  override?: ModelCapabilityOverride,
): boolean {
  if (isDefaultThinkingLevelModel(model)) return true;
  if (!override) return false;

  return Array.isArray(override) ? override.includes(model) : override(model);
}
