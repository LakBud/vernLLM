import type { CallLogRecord, LogLevel } from '../../types/index.js';
import type { CallResult } from 'vern-llm';

// Errors are recognised by shape, never `instanceof`: the ESM and CJS builds of vern-llm
// have separate `LLMError` classes.

interface LLMErrorLike {
  name: 'LLMError';
  type: string;
  code?: unknown;
  status?: unknown;
  attempts?: unknown;
}

export function isLLMErrorLike(error: unknown): error is LLMErrorLike {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; type?: unknown };
  return candidate.name === 'LLMError' && typeof candidate.type === 'string';
}

export type RecorderOutcome =
  | { kind: 'result'; result: CallResult }
  | { kind: 'error'; error: unknown };

export interface ClassifiedOutcome {
  outcome: CallLogRecord['outcome'];
  level: LogLevel;
  /** Only `type`, `code` and `status`, never the message: it can contain prompt text. */
  error?: NonNullable<CallLogRecord['error']>;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';

function statusOf(error: LLMErrorLike): number | undefined {
  const { status } = error;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/** The rules that turn how a call ended into an outcome and a level. */
export function classifyOutcome(outcome: RecorderOutcome): ClassifiedOutcome {
  if (outcome.kind === 'result') return { outcome: 'ok', level: 'info' };

  const { error } = outcome;
  if (!isLLMErrorLike(error))
    return { outcome: 'error', level: 'error', error: { type: 'unknown' } };

  const summary: NonNullable<ClassifiedOutcome['error']> = { type: error.type };
  if (isNonEmptyString(error.code)) summary.code = error.code;
  const status = statusOf(error);
  if (status !== undefined) summary.status = status;

  // The caller cancelled, which is not a fault of the provider or of this app.
  if (error.type === 'aborted') return { outcome: 'aborted', level: 'info', error: summary };
  if (error.type === 'quota_exceeded' || error.code === 'policy_denied') {
    return { outcome: 'rejected', level: 'warn', error: summary };
  }
  return { outcome: 'error', level: 'error', error: summary };
}

/** `code` when the error has one, else `type`. Both are enumerated. */
export function errorCodeOf(error: unknown): string {
  if (!isLLMErrorLike(error)) return 'unknown';
  return isNonEmptyString(error.code) ? error.code : error.type;
}

/** The error that ended the last attempt, which an exhausted fallback chain hides. */
export function lastAttemptErrorOf(error: unknown): unknown {
  if (!isLLMErrorLike(error) || error.type !== 'fallback_exhausted') return error;
  if (!Array.isArray(error.attempts) || error.attempts.length === 0) return error;

  const snapshot = (error.attempts[error.attempts.length - 1] as { error?: unknown } | null)?.error;
  if (typeof snapshot !== 'object' || snapshot === null) return error;

  const { type, code } = snapshot as { type?: unknown; code?: unknown };
  return typeof type === 'string' ? { name: 'LLMError', type, code } : error;
}

// Codes the core and its adapters throw from inside the provider request before anything is
// sent: a capability the model rejects, or an inner `dispatch` hook that never called `next`.
const LOCAL_REJECTION_CODES: ReadonlySet<unknown> = new Set([
  'unsupported_capability',
  'middleware_threw',
]);

/** Whether a failed dispatch never reached the provider, so it is not an attempt. */
export function isLocalRejection(error: unknown): boolean {
  return (
    isLLMErrorLike(error) &&
    error.type === 'invalid_params' &&
    LOCAL_REJECTION_CODES.has(error.code) &&
    statusOf(error) === undefined
  );
}
