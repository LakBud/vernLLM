import { ConsoleLogger, type Logger } from 'vern-llm';

/** An adapter's `logger` option, as `VernLLMOptions.logger`. */
export type AdapterLoggerOption = Logger | 'silent';

/** An adapter's logger: its own option if given, else VernLLM's once wired in, else the console. */
export interface AdapterLogger {
  /** VernLLM's logger. Ignored when the adapter has its own. */
  adopt(logger: Logger): void;
  /** Logs a failed background operation with the `[VernLLM]` prefix. */
  failure(operation: string, error: unknown, key?: string): void;
  /** Silences output after dispose. */
  mute(): void;
}

export function createAdapterLogger(
  adapterName: string,
  option: AdapterLoggerOption | undefined,
): AdapterLogger {
  const explicit = option !== undefined;
  let current: Logger | undefined =
    option === 'silent' ? undefined : (option ?? new ConsoleLogger(false));
  let muted = false;

  return {
    adopt(logger) {
      if (!explicit) current = logger;
    },

    failure(operation, error, key) {
      if (muted || !current) return;

      const where = key === undefined ? '' : ` for key "${key}"`;
      current.error(`[VernLLM] ${adapterName}: ${operation} failed${where}`, {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        ...(key === undefined ? {} : { key }),
      });
    },

    mute() {
      muted = true;
    },
  };
}
