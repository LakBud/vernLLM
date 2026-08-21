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
 */
export function resolveEffortTokenTable(override?: Partial<EffortTokenTable>): EffortTokenTable {
  return override ? { ...DEFAULT_EFFORT_TOKENS, ...override } : DEFAULT_EFFORT_TOKENS;
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
 * same (possibly overridden) table is passed to both.
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
