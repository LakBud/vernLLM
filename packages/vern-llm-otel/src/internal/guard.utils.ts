import { ConsoleLogger, type Logger } from 'vern-llm';

/** Same shape as `VernLLMOptions.logger`. */
export type LoggerOption = Logger | 'silent';

/**
 * Runs `fn` and returns `fallback` if it throws, after logging the failure. Every call the
 * middleware makes into its own code and every user callback goes through this, because
 * telemetry must never change what the call itself returns or throws.
 *
 * Synchronous on purpose: a returned promise is handed back untouched, so a caller's own
 * rejection is never swallowed here.
 */
export interface Guard {
  <T>(operation: string, fn: () => T, fallback: T): T;
  /** Logs a failure in the same shape without running anything, for misuse detected by the caller. */
  report(operation: string, error: unknown): void;
}

export function createGuard(option: LoggerOption | undefined): Guard {
  const logger: Logger | undefined =
    option === 'silent' ? undefined : (option ?? new ConsoleLogger(false));

  const report = (operation: string, error: unknown): void => {
    if (!logger) return;

    try {
      logger.error(`[VernLLM] otel: ${operation} failed`, {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } catch {
      // A logger that throws must not be able to break a call.
    }
  };

  const guard = (<T>(operation: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (error) {
      report(operation, error);
      return fallback;
    }
  }) as Guard;

  guard.report = report;
  return guard;
}
