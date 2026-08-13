import type { LLMError } from './errors.js';

export interface UsageInfo {
  coalesced: boolean;
}

export type ReserveUsage = (params: { coalesced: boolean; signal?: AbortSignal }) => Promise<void>;

export type RefundUsage = (params: { coalesced: boolean; signal?: AbortSignal }) => Promise<void>;

/**
 * The reserve/refund usage hooks shared by `CallParams`, `CachedCallParams`,
 * and `VernLLM`'s internal `withReservedUsage`. Centralized here so the pair
 * has one definition instead of being redeclared at each use site.
 */
export interface UsageHooks {
  /**
   * Reserves usage before the request. Failures become
   * LLMError('quota_exceeded').
   */
  reserveUsage?: ReserveUsage;

  /**
   * Refunds usage after a failed call if reservation succeeded.
   */
  refundUsage?: RefundUsage;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestId: string;
  model: string;
  /**
   * The provider target that produced this usage. See `VernLLMOptions['name']`,
   * default `'primary'`. Optional so consumers constructing a `TokenUsage`
   * themselves (e.g. in tests) aren't forced to supply it; `VernLLM` always
   * populates it. Absent means the same as `'primary'` if you need a value.
   */
  provider?: string;
  /**
   * Whether this usage came from a fallback target rather than the
   * primary. Optional for the same reason `provider` is: `VernLLM`
   * always populates it, a hand-constructed `TokenUsage` (e.g. in tests)
   * isn't forced to.
   */
  usedFallback?: boolean;
}

export type OnUsage = (usage: TokenUsage) => void;

/**
 * Called when a provider response arrives but VernLLM's own post-processing
 * then fails, after usage data was already present in that response. Covers
 * any error thrown after usage extraction, not just parse/validation, since
 * everything in that path only runs once a response, and real spend, has
 * already arrived. Fires once per failed attempt with extractable usage,
 * never for transport failures, where no response means no honest number
 * to report.
 */
export type OnUsageFailure = (usage: TokenUsage, error: LLMError) => void;
