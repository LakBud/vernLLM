import { ConsoleLogger, type Logger } from 'vern-llm';

import type { LoggerOption } from '../types/index.js';

/** Runs `fn`, and logs and returns `fallback` if it throws: metering must never change a call. */
export interface Guard {
  <T>(operation: string, fn: () => T, fallback: T): T;
  /** Logs a failure without running anything. */
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
      logger.error(`[VernLLM] usage: ${operation} failed`, {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } catch {
      // A throwing logger must not break a call.
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
      logger.warn(`[VernLLM] usage: ${message}`);
    } catch {
      // Same as `report`.
    }
  };
  return guard;
}
