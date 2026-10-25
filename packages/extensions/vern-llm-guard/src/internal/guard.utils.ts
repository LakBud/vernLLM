import { ConsoleLogger, type Logger } from 'vern-llm';

import type { LoggerOption } from '../types/index.js';

export interface Guard {
  /** Logs a failure in the same shape without running anything. */
  report(operation: string, error: unknown): void;
  /** Logs a configuration warning, not a failure. */
  warn(message: string): void;
  /** Like `warn`, but each `key` only once for the life of the guard. */
  warnOnce(key: string, message: string): void;
}

export function createGuard(option: LoggerOption | undefined): Guard {
  const logger: Logger | undefined =
    option === 'silent' ? undefined : (option ?? new ConsoleLogger(false));
  const warned = new Set<string>();

  const report = (operation: string, error: unknown): void => {
    if (!logger) return;

    try {
      logger.error(`[VernLLM] guard: ${operation} failed`, {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } catch {
      // A throwing logger must not break a call.
    }
  };

  const warn = (message: string): void => {
    if (!logger) return;
    try {
      logger.warn(`[VernLLM] guard: ${message}`);
    } catch {
      // Same as `report`.
    }
  };

  return {
    report,
    warn,
    warnOnce: (key, message) => {
      if (warned.has(key)) return;
      warned.add(key);
      warn(message);
    },
  };
}
