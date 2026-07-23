export type ReserveUsage = () => Promise<void>;
export type RefundUsage = () => Promise<void>;

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestId: string;
  model: string;
}

export type OnUsage = (usage: TokenUsage) => void;
