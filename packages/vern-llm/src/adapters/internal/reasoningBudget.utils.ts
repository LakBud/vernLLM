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
 */

const EFFORT_TO_BUDGET_TOKENS: Record<'minimal' | 'low' | 'medium' | 'high', number> = {
  minimal: 1024,
  low: 4096,
  medium: 16000,
  high: 32000,
};

/** Converts a `reasoningEffort` tier into the nearest `budgetTokens` value. */
export function effortToBudgetTokens(effort: 'minimal' | 'low' | 'medium' | 'high'): number {
  return EFFORT_TO_BUDGET_TOKENS[effort];
}

/**
 * Converts a raw `budgetTokens` value into the nearest `reasoningEffort`
 * tier, for providers that only understand tiers. Buckets by the same
 * thresholds `effortToBudgetTokens` produces, so the two functions agree
 * with each other at the boundary values.
 */
export function budgetTokensToEffort(budgetTokens: number): 'minimal' | 'low' | 'medium' | 'high' {
  if (budgetTokens <= EFFORT_TO_BUDGET_TOKENS.minimal) return 'minimal';
  if (budgetTokens <= EFFORT_TO_BUDGET_TOKENS.low) return 'low';
  if (budgetTokens <= EFFORT_TO_BUDGET_TOKENS.medium) return 'medium';
  return 'high';
}
