import { ConsoleLogger, type Logger } from 'vern-llm';

import type { LoggerOption } from '../types/index.js';

/** Runs `fn`, and returns `fallback` after logging if it throws. */
export interface Guard {
  <T>(operation: string, fn: () => T, fallback: T): T;
  /** Logs a failure in the same shape without running anything. */
  report(operation: string, error: unknown): void;
  /** Logs a configuration warning, not a failure. */
  warn(message: string): void;
  /** Like `warn`, but each `key` only once for the life of the hedge. */
  warnOnce(key: string, message: string): void;
}

export function createGuard(option: LoggerOption | undefined): Guard {
  const logger: Logger | undefined =
    option === 'silent' ? undefined : (option ?? new ConsoleLogger(false));
  const warned = new Set<string>();

  const report = (operation: string, error: unknown): void => {
    if (!logger) return;

    try {
      logger.error(`[VernLLM] hedge: ${operation} failed`, {
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
      logger.warn(`[VernLLM] hedge: ${message}`);
    } catch {
      // Same as `report`: a throwing logger must not break a call.
    }
  };
  guard.warnOnce = (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    guard.warn(message);
  };
  return guard;
}
