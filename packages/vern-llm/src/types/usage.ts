export interface UsageInfo {
  coalesced: boolean;
}

export type ReserveUsage = (info: UsageInfo) => Promise<void>;
export type RefundUsage = (info: UsageInfo) => Promise<void>;

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestId: string;
  model: string;
}

export type OnUsage = (usage: TokenUsage) => void;
