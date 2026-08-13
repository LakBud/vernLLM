export type LLMErrorType =
  | 'timeout'
  | 'api'
  | 'parse'
  | 'validation'
  | 'circuit_open'
  | 'quota_exceeded'
  | 'unknown'
  | 'aborted';

/**
 * Machine readable discriminator within a `type`, for cases where `type`
 * alone is too coarse to act on. Optional and additive: errors thrown
 * before a given code existed simply omit it.
 */
export type LLMErrorCode =
  | 'unknown_tool'
  | 'duplicate_tool_call_id'
  | 'local_rate_limit'
  | 'provider_rate_limited'
  | 'fallback_exhausted';

/** One tool call's contract failure, used to report every bad call in a response at once. */
export interface ToolIssue {
  name: string;
  toolCallId: string;
  code: LLMErrorCode;
  detail?: unknown;
}

export class LLMError extends Error {
  constructor(
    message: string,
    public type: LLMErrorType,
    public status?: number,
    public issues?: unknown,
    public cause?: unknown,
    public retryAfterMs?: number,
    /** Stable discriminator within `type`. Absent on errors predating it. */
    public code?: LLMErrorCode,
  ) {
    super(message);
    this.name = 'LLMError';
  }

  /** Every tool contract failure in one response, when there is more than one. */
  toolIssues?: ToolIssue[];
}

export function isLLMError(err: unknown): err is LLMError {
  return err instanceof LLMError;
}
