import type { Logger } from '../../logger.js';

/** Logs a user hook that threw, as `[VernLLM] <hookName> failed` with message and stack. */
export function logHookError(logger: Logger, hookName: string, error: unknown): void {
  logError(logger, `[VernLLM] ${hookName} failed`, error);
}

/** An error's message, or `'unknown'` for a non-Error throw. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

/** Logs `message` at error level with the error's message and stack kept. */
export function logError(logger: Logger, message: string, error: unknown): void {
  logger.error(message, {
    message: errorMessage(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}

/**
 * Calls a synchronous, user-supplied hook and swallows/logs anything it
 * throws via `logHookError`, so a broken hook can never break the call
 * that triggered it.
 */
export function callHookSafely(logger: Logger, hookName: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    logHookError(logger, hookName, error);
  }
}

/**
 * Wraps a user supplied `Logger` so a throwing one can never break the call it describes. Wrapped
 * once, so call sites need no guard.
 */
export function createSafeLogger(logger: Logger): Logger {
  return {
    debug: safe(logger, 'debug'),
    warn: safe(logger, 'warn'),
    error: safe(logger, 'error'),
  };
}

function safe<M extends 'debug' | 'warn' | 'error'>(logger: Logger, method: M): Logger[M] {
  const fn = (logger[method] as (...args: Parameters<Logger[M]>) => unknown).bind(logger);

  return ((...args: Parameters<Logger[M]>) => {
    try {
      swallowRejection(fn(...args));
    } catch {
      // a broken logger must never break the call it's describing
    }
  }) as Logger[M];
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown>)?.then === 'function';
}

function swallowRejection(result: unknown): void {
  if (isPromiseLike(result)) {
    Promise.resolve(result).catch(() => {
      // a broken logger must never break the call it's describing
    });
  }
}

/** Discards every call. Used for `logger: 'silent'`. */
export class NoopLogger implements Logger {
  debug(_message: string): void {}
  warn(_message: string): void {}
  error(_message: string, _meta?: Record<string, unknown>): void {}
}
