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
  /**
   * Reasoning tokens, a subset of `completionTokens`, not extra. `undefined` when the provider
   * doesn't report them separately.
   */
  reasoningTokens?: number;
  requestId: string;
  model: string;
  /**
   * The target that produced this usage, `'primary'` by default. Always set by VernLLM; optional
   * for hand built values.
   */
  provider?: string;
  /**
   * Whether a fallback target produced this usage. Always set by VernLLM; optional for hand built
   * values.
   */
  usedFallback?: boolean;
}

export type OnUsage = (usage: TokenUsage) => void;

/**
 * Called when a response carried usage but post-processing failed. Once per such attempt; never for
 * transport failures, which have no usage to report.
 */
export type OnUsageFailure = (usage: TokenUsage, error: LLMError) => void;
