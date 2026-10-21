import type { LogEntry } from './entries.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Where entries go. One method, so adapting any logger is a few lines. */
export interface LogSink {
  write(level: LogLevel, entry: LogEntry): void | Promise<void>;
}
