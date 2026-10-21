import type { ResolvedPrice } from '../../types/index.js';

/** The token counts a charge needs. A vern-llm `TokenUsage` satisfies it. */
export interface TokenCounts {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteTokensByTtl?: Readonly<Record<string, number>>;
}

/** A provider count as a whole number of at least zero. Anything else counts as none. */
function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * The cost of one usage report in integer nano dollars. Cache and reasoning tokens are priced at
 * their own rates, not added on top.
 */
export function chargeNanoUsd(tokens: TokenCounts, price: ResolvedPrice): number {
  const prompt = count(tokens.promptTokens);
  const completion = count(tokens.completionTokens);
  const cacheRead = count(tokens.cacheReadTokens);

  let writes = 0;
  let writeCost = 0;
  for (const [ttl, ttlTokens] of Object.entries(tokens.cacheWriteTokensByTtl ?? {})) {
    const n = count(ttlTokens);
    writes += n;
    writeCost += n * (price.cacheWriteByTtl.get(ttl) ?? price.cacheWrite);
  }

  // A total above the TTL split takes the flat rate.
  const totalWrites = Math.max(count(tokens.cacheWriteTokens), writes);
  writeCost += (totalWrites - writes) * price.cacheWrite;

  const uncached = Math.max(0, prompt - cacheRead - totalWrites);
  const reasoning = Math.min(count(tokens.reasoningTokens), completion);

  return (
    uncached * price.input +
    cacheRead * price.cacheRead +
    writeCost +
    reasoning * price.reasoning +
    (completion - reasoning) * price.output
  );
}

/** Prompt plus completion tokens, what a token budget counts. Reasoning is inside completion. */
export function totalTokens(tokens: TokenCounts): number {
  return count(tokens.promptTokens) + count(tokens.completionTokens);
}

/** Integer nano dollars as the plain USD number the public API reports. */
export function nanoToUsd(nanoUsd: number): number {
  return nanoUsd / 1e9;
}

/** The token kinds of one report, each a whole number of at least zero. */
export function tokenKinds(tokens: TokenCounts): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
} {
  const writesByTtl = Object.values(tokens.cacheWriteTokensByTtl ?? {}).reduce<number>(
    (sum, n) => sum + count(n),
    0,
  );
  return {
    input: count(tokens.promptTokens),
    output: count(tokens.completionTokens),
    cacheRead: count(tokens.cacheReadTokens),
    cacheWrite: Math.max(count(tokens.cacheWriteTokens), writesByTtl),
    reasoning: count(tokens.reasoningTokens),
  };
}

/** A scope's amount in the unit the public API reports: USD for dollar scopes, tokens otherwise. */
export function toPublicAmount(unit: 'usd' | 'tokens', amount: number): number {
  return unit === 'usd' ? nanoToUsd(amount) : amount;
}

/** The cost a provider reported in nano dollars, or `undefined` when unusable. Zero is usable. */
export function reportedNanoUsd(costUsd: number | undefined): number | undefined {
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) return undefined;

  const nano = Math.round(costUsd * 1e9);
  return Number.isSafeInteger(nano) ? nano : undefined;
}
