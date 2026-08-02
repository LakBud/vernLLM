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
}

export type OnUsage = (usage: TokenUsage) => void;
