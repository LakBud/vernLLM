export interface Logger {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Default logger. `debug` is gated by the `debug` option on VernLLM
 * warn/error always fire since they indicate real problems (retries, cache failures)
 */
export class ConsoleLogger implements Logger {
  constructor(private debugEnabled: boolean) {}

  debug(message: string): void {
    if (this.debugEnabled) console.debug(message);
  }

  warn(message: string): void {
    console.warn(message);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    console.error(message, meta ?? '');
  }
}
