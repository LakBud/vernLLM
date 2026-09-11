import type { Logger } from '../../logger.js';

/**
 * Logs a user-supplied hook (`onEvent`, `onUsage`, a middleware method, etc.)
 * throwing, in the shared `[VernLLM] <hookName> failed` shape. Centralized so
 * every call site reduces the error the same way instead of re-deriving
 * `message`/`stack` inline, and so the `[VernLLM]` prefix can't drift.
 */
export function logHookError(logger: Logger, hookName: string, error: unknown): void {
  logger.error(`[VernLLM] ${hookName} failed`, {
    message: error instanceof Error ? error.message : 'unknown',
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
 * Wraps a `Logger` so a throwing implementation can never break the call
 * it's trying to describe. `logger` is user-supplied (`VernLLMOptions.logger`),
 * so a custom logger that ships to a file, Datadog, etc. can throw for
 * reasons unrelated to VernLLM. Wrap once at construction so every
 * downstream `this.logger.warn(...)` call stays as-is and is safe by
 * construction, instead of guarding each call site individually.
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
