export type LLMErrorType =
  | 'timeout'
  | 'api'
  | 'parse'
  | 'validation'
  | 'circuit_open'
  | 'unknown'
  | 'aborted';

export class LLMError extends Error {
  constructor(
    message: string,
    public type: LLMErrorType,
    public status?: number,
    public issues?: unknown,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

export function isLLMError(err: unknown): err is LLMError {
  return err instanceof LLMError;
}
