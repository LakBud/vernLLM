import { isNonEmptyString, put } from '../attributes/values.utils.js';
import { ATTR, ERROR_CODE_FALLBACK_EXHAUSTED, ERROR_TYPE_OTHER, VERNLLM_ATTR } from '../semconv.js';

import type { Attributes } from '@opentelemetry/api';

// Errors are recognised by shape, never with `instanceof` or `isLLMError`. vern-llm ships an ESM
// and a CJS build with a separate `LLMError` class each, so a single install can still hold two
// classes: an app that builds its VernLLM through ESM while this package is loaded through
// `require` (or the reverse), or a bundler that resolves different conditions for each. A second
// nested copy of vern-llm does the same. A class check would then fail for every real error and
// report all of them as `_OTHER`, silently losing the error type and status.

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

/** `code` when the error has one, else `type`. Both are enumerated, so cardinality stays low. */
export function errorTypeOf(error: unknown): string {
  if (!isLLMErrorLike(error)) return ERROR_TYPE_OTHER;
  if (isNonEmptyString(error.code)) return error.code;
  return isNonEmptyString(error.type) ? error.type : ERROR_TYPE_OTHER;
}

/** The same low cardinality string, never the provider's message: it can echo prompt text. */
export function statusMessageOf(error: unknown): string {
  return errorTypeOf(error);
}

export function httpStatusOf(error: unknown): number | undefined {
  if (!isLLMErrorLike(error)) return undefined;
  const { status } = error;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/** Number of targets tried, when the error is a fallback exhausted one with a readable list. */
export function fallbackAttemptCountOf(error: unknown): number | undefined {
  if (!isLLMErrorLike(error)) return undefined;
  const exhausted =
    error.code === ERROR_CODE_FALLBACK_EXHAUSTED || error.type === ERROR_CODE_FALLBACK_EXHAUSTED;
  return exhausted && Array.isArray(error.attempts) ? error.attempts.length : undefined;
}

export interface ExceptionRecord {
  name: string;
  message: string;
  stack?: string;
}

/**
 * What an `exception` span event carries. The message is the same low cardinality code used
 * for the span status, never the error's own message, which can echo prompt text. A stack is
 * added only when asked for, and only when the error has one.
 */
export function exceptionOf(error: unknown, includeStack: boolean): ExceptionRecord {
  const record: ExceptionRecord = {
    name: isLLMErrorLike(error) ? 'LLMError' : 'Error',
    message: errorTypeOf(error),
  };

  const stack =
    typeof error === 'object' && error !== null ? (error as { stack?: unknown }).stack : undefined;
  if (includeStack && typeof stack === 'string') record.stack = stack;

  return record;
}

/**
 * The error that ended the last attempt. An exhausted fallback chain throws its own summary
 * error, but the attempt still open when it is thrown failed for the last target's reason, and
 * that reason is what the attempt span and duration metric should carry. Anything else is
 * returned unchanged.
 */
export function lastAttemptErrorOf(error: unknown): unknown {
  if (fallbackAttemptCountOf(error) === undefined) return error;

  const attempts = (error as LLMErrorLike).attempts as unknown[];
  const snapshot = (attempts[attempts.length - 1] as { error?: unknown } | null | undefined)?.error;
  if (typeof snapshot !== 'object' || snapshot === null) return error;

  const { type, code, status } = snapshot as { type?: unknown; code?: unknown; status?: unknown };
  return typeof type === 'string' ? { name: 'LLMError', type, code, status } : error;
}

export function errorAttributes(error: unknown): Attributes {
  const attrs: Attributes = { [ATTR.errorType]: errorTypeOf(error) };
  put(attrs, ATTR.httpStatusCode, httpStatusOf(error));
  put(attrs, VERNLLM_ATTR.fallbackAttempts, fallbackAttemptCountOf(error));
  return attrs;
}
