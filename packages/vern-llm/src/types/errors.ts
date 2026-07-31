export type LLMErrorType =
  | 'timeout'
  | 'api'
  | 'parse'
  | 'validation'
  | 'circuit_open'
  | 'quota_exceeded'
  | 'unknown'
  | 'aborted';

export class LLMError extends Error {
  constructor(
    message: string,
    public type: LLMErrorType,
    public status?: number,
    public issues?: unknown,
    public cause?: unknown,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

export function isLLMError(err: unknown): err is LLMError {
  return err instanceof LLMError;
}
