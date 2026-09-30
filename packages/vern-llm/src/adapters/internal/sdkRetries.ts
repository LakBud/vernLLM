import type { Logger } from '../../logger.js';

/**
 * Adapter names already warned about. Module scoped so the warning prints once per process for
 * each SDK, not again for every client or `VernLLM` instance an app builds, such as one per
 * request in a serverless handler.
 */
const warnedAdapters = new Set<string>();

/** Clears the once per process state. Tests only; not exported from the package. */
export function resetSdkRetryWarnings(): void {
  warnedAdapters.clear();
}

/**
 * Returns a `setLogger` body that warns when the wrapped SDK client retries on its own. Those
 * retries happen inside one `create()` call, where VernLLM's retries, breaker, limiter, and events
 * can't see them. `readRetries` returns `undefined` for a client that isn't the SDK (a fake or a
 * thin wrapper), which stays silent.
 */
export function sdkRetryWarning(
  adapterName: string,
  readRetries: () => number | undefined,
  fix: string,
): (logger: Logger) => void {
  return (logger) => {
    if (warnedAdapters.has(adapterName)) return;
    const retries = readRetries();
    // `> 0` also rejects NaN, which the SDKs would treat as no retry.
    if (retries === undefined || !(retries > 0)) return;

    warnedAdapters.add(adapterName);
    logger.warn(
      `[VernLLM] ${adapterName}: the SDK client retries up to ${retries} times on its own, ` +
        `hidden from VernLLM's retries, circuit breaker, rate limiter, and events. ${fix} so ` +
        'VernLLM is the only retry owner.',
    );
  };
}

/** `maxRetries` off a Stainless generated client (`openai`, `@anthropic-ai/sdk`, `groq-sdk`). */
export function readMaxRetries(client: unknown): number | undefined {
  const value = (client as { maxRetries?: unknown } | null)?.maxRetries;
  return typeof value === 'number' ? value : undefined;
}
