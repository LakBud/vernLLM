import type { Logger } from '../logger.js';

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
  return ((...args: Parameters<Logger[M]>) => {
    try {
      (logger[method] as (...a: Parameters<Logger[M]>) => void)(...args);
    } catch {
      // a broken logger must never break the call it's describing
    }
  }) as Logger[M];
}
