import { redactResponseBody } from '../../utils/errors/responseBody.utils.js';
import { extractStatus, normalizeError } from '../utils/errors.utils.js';

import type { RateLimiterAdapter } from '../../../rateLimit.js';
import type { AttemptEnvironment } from './attemptEnvironment.js';

/** Tells the limiter about a provider 429 so AIMD can shrink. */
export function reactToRateLimitError(
  limiter: RateLimiterAdapter | undefined,
  error: unknown,
): void {
  if (!limiter) return;
  if (extractStatus(error) !== 429) return;
  limiter.signalRateLimit();
}

/**
 * Runs `send` inside the attempt's `dispatch` hooks. A provider failure is
 * redacted and reported to the limiter, and hooks see it normalized. The raw
 * error is rethrown afterwards, not the `LLMError` hooks saw, since retry
 * timing reads `Retry-After` off it. Anything else, such as a hook that never
 * sent the request, is thrown as is.
 */
export async function dispatchToProvider(
  env: AttemptEnvironment,
  dispatch: (send: () => Promise<void>) => Promise<void>,
  signal: AbortSignal | undefined,
  send: () => Promise<void>,
): Promise<void> {
  let providerFailure: { error: unknown } | undefined;

  try {
    await dispatch(async () => {
      try {
        await send();
      } catch (error) {
        if (env.redact) redactResponseBody(error, env.redact);
        reactToRateLimitError(env.limiter, error);
        providerFailure = { error };
        throw normalizeError(error, signal, undefined, env.maxRetryAfterMs);
      }
    });
  } catch (error) {
    throw providerFailure ? providerFailure.error : error;
  }
}
