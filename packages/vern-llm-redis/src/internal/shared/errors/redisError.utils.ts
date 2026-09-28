import { LLMError } from 'vern-llm';

/** A Redis failure as `LLMError('network')` with code `connection_failed` and the error as `cause`. LLMErrors pass through. */
export function toRedisError(operation: string, error: unknown): LLMError {
  if (error instanceof LLMError) return error;

  const detail = error instanceof Error ? error.message : String(error);
  return new LLMError(`Redis ${operation} failed: ${detail}`, 'network', {
    code: 'connection_failed',
    cause: error,
  });
}
