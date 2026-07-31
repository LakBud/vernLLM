export interface UsageInfo {
  coalesced: boolean;
}

export type ReserveUsage = (params: { coalesced: boolean; signal?: AbortSignal }) => Promise<void>;

export type RefundUsage = (params: { coalesced: boolean; signal?: AbortSignal }) => Promise<void>;

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestId: string;
  model: string;
}

export type OnUsage = (usage: TokenUsage) => void;
