import { ConsoleLogger, type Logger } from 'vern-llm';

/** What an adapter's own `logger` option accepts, same as `VernLLMOptions.logger`. */
export type AdapterLoggerOption = Logger | 'silent';

/**
 * The logger one adapter reports through. Starts as `options.logger` if
 * one was given, otherwise a plain `ConsoleLogger`. When `VernLLM` wires
 * the adapter in it calls `setLogger` with the instance's own logger, and
 * that replaces the default so the adapter follows the same `logger` and
 * `'silent'` settings as everything else. A logger passed to the adapter
 * explicitly always wins: it was a deliberate choice for this adapter.
 */
export interface AdapterLogger {
  /** Called by `VernLLM` through the adapter's `setLogger`. Ignored when the adapter was given its own logger. */
  adopt(logger: Logger): void;
  /** Reports a failed background operation in the shared `[VernLLM]` shape, with the error in `meta`. */
  failure(operation: string, error: unknown, key?: string): void;
  /** Stops all output, used once the adapter is disposed and a closing client failing is expected. */
  mute(): void;
}

export function createAdapterLogger(
  adapterName: string,
  option: AdapterLoggerOption | undefined,
): AdapterLogger {
  const explicit = option !== undefined;
  // `undefined` means silent: nothing to call, so there is no logger object
  // whose unused debug and warn methods would need to exist.
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
