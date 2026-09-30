import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { Logger } from 'vern-llm';

/**
 * Module scoped so the warning prints once per process, not again for every client or `VernLLM`
 * instance an app builds, such as one per request in a serverless handler.
 */
let warned = false;

/** Clears the once per process state. Tests only; not exported from the package. */
export function resetBedrockRetryWarning(): void {
  warned = false;
}

/**
 * Returns a `setLogger` body that warns when the AWS SDK retries on its own. Those retries happen
 * inside one `send()`, where VernLLM's retries, breaker, limiter, and events can't see them. The
 * same check lives in `vern-llm`'s adapters, which this package can't import, so keep the wording
 * and the once per process rule in step with it.
 *
 * `config.maxAttempts` is an async provider that counts the first call and also reads
 * `AWS_MAX_ATTEMPTS`, so the warning lands once it resolves. A provider that rejects, or a stubbed
 * client without one, stays silent: the warning is advice and must never fail construction.
 */
export function bedrockRetryWarning(client: BedrockRuntimeClient): (logger: Logger) => void {
  return (logger) => {
    if (warned) return;

    Promise.resolve()
      .then(() => {
        // A hand written client without `config.maxAttempts` throws here and lands in the `catch`,
        // the same as a provider that rejects.
        const { maxAttempts } = (client as { config: { maxAttempts: () => unknown } }).config;
        return maxAttempts();
      })
      .then((attempts) => {
        // Checked again here: several clients can resolve at once, and only the first may warn.
        // `> 1` also rejects NaN and anything that isn't a number.
        if (warned || typeof attempts !== 'number' || !(attempts > 1)) return;

        warned = true;
        logger.warn(
          `[VernLLM] bedrock: the SDK client retries up to ${attempts - 1} times on its own, ` +
            "hidden from VernLLM's retries, circuit breaker, rate limiter, and events. Pass " +
            'maxAttempts: 1 to the BedrockRuntimeClient so VernLLM is the only retry owner.',
        );
      })
      .catch(() => {});
  };
}
