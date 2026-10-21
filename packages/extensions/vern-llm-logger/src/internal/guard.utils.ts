import { ConsoleLogger, type Logger } from 'vern-llm';

/** Same shape as `VernLLMOptions.logger`. */
export type LoggerOption = Logger | 'silent';

/** Runs `fn`, and returns `fallback` after logging if it throws. */
export interface Guard {
  <T>(operation: string, fn: () => T, fallback: T): T;
  /** Logs a failure in the same shape without running anything. */
  report(operation: string, error: unknown): void;
  /** Logs a configuration warning, not a failure. */
  warn(message: string): void;
}

export function createGuard(option: LoggerOption | undefined): Guard {
  const logger: Logger | undefined =
    option === 'silent' ? undefined : (option ?? new ConsoleLogger(false));

  const report = (operation: string, error: unknown): void => {
    if (!logger) return;

    try {
      logger.error(`[VernLLM] logger: ${operation} failed`, {
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
  guard.warn = (message) => {
    if (!logger) return;
    try {
      logger.warn(`[VernLLM] logger: ${message}`);
    } catch {
      // Same as `report`: a throwing logger must not break a call.
    }
  };
  return guard;
}
