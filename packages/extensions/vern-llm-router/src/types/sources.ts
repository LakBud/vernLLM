import type { WireCallRequest } from 'vern-llm';

/** A circuit breaker state, as the core reports it. */
export type CircuitStateName = 'closed' | 'open' | 'half-open';

/**
 * What the router reads about health. `VernLLM` matches this structurally, so
 * `health: () => llm` works without an adapter.
 */
export interface HealthSource {
  /** Every target's breaker state, in chain order. `state` is absent without a breaker. */
  getCircuitStates(): readonly { provider: string; index: number; state?: CircuitStateName }[];
  /** A target's local rate limit levels, when it has a limiter. */
  getRateLimitState?(target: {
    index: number;
  }): { requestsRemaining?: number; tokensRemaining?: number } | undefined;
}

/**
 * Rolling stats, such as `logger.stats` from `vern-llm-logger`. The logger matches this
 * structurally. The router asks only for `attemptMs`, `outputTokensPerSec` and `outputTokens`.
 */
export interface StatsSource {
  quantile(
    filter: Readonly<Record<string, string>>,
    q: number,
    metric?: string,
  ): number | undefined;
  /** Share of responded attempts whose answer was rejected as unusable, or `undefined` if unknown. */
  failureRate?(filter: Readonly<Record<string, string>>, kind: 'quality'): number | undefined;
}

/** The most `request` could cost on `target`, in USD. `usage.costFor` from `vern-llm-usage` fits. */
export type CostSource = (
  target: { name: string; model: string },
  request: Readonly<WireCallRequest>,
) => number | undefined;
