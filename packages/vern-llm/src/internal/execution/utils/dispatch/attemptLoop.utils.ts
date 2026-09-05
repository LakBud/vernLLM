import { LLMError, type LLMRequestSnapshot, type RetryAttempt } from '../../../../types/errors.js';
import { createMiddlewareStateBag } from '../../../../types/middleware.js';
import { idFor } from '../../../resolveMiddlewareOrder.js';
import { createBreakerGateway, type BreakerGateway } from '../../circuitBreakerContext.js';
import { describeError, extractStatus, normalizeError } from '../errors.utils.js';
import { emitEvent } from '../middleware/middleware.utils.js';
import { recoverDelay, retryWithBackoff, shouldRetry } from '../retry/retry.utils.js';

import type { CircuitBreaker } from '../../../../circuitBreaker.js';
import type { Logger } from '../../../../logger.js';
import type {
  MiddlewareStateBag,
  VernLLMEvent,
  VernLLMMiddleware,
} from '../../../../types/index.js';
import type { RetryBudget } from '../../../retryBudget.js';

/**
 * Everything `runAttemptLoop` needs beyond the per-call `fn` it retries.
 * Mirrors what `run`/`runStream` used to build by hand for
 * `retryWithBackoff`, plus the breaker/logging wiring that used to live
 * in their own `catch` blocks.
 */
export interface RunAttemptLoopParams<T> {
  fn: (
    attempt: number,
    onRequest: (snapshot: LLMRequestSnapshot | undefined) => void,
    state: MiddlewareStateBag,
    gateway: BreakerGateway,
  ) => Promise<T>;
  requestId: string;
  model: string;
  providerName: string;
  isFallback: boolean;
  supportsJsonObjectMode: boolean;
  breaker?: CircuitBreaker;
  /**
   * Caps how much of this target's recent traffic is allowed to be
   * retries, independent of `breaker`. See `RetryBudget`. Undefined
   * means no budget, exactly today's behavior.
   */
  budget?: RetryBudget;
  maxRetries: number;
  baseDelayMs: number;
  nonRetryableStatus: number[];
  signal?: AbortSignal;
  onAttempt?: () => void;
  state?: MiddlewareStateBag;
  middleware: VernLLMMiddleware[];
  middlewareTimeoutMs: number;
  logger: Logger;
  reportEvent: (event: VernLLMEvent) => void;
  /**
   * Label folded into the debug log line on terminal failure, e.g.
   * `'error'` for `run`, `'stream-open error'` for `runStream`, so the
   * two calls stay distinguishable in logs despite sharing this loop.
   */
  logLabel: string;
  /** Applied to the logged error description. See `VernLLMOptions.redact`. */
  redactText: (text: string) => string;
  /**
   * Decides whether the terminal failure counts toward the breaker's
   * failure threshold. See `CallExecutor`'s own `countsTowardBreaker`,
   * which this is injected from.
   */
  countsTowardBreaker: (error: LLMError) => boolean;
}

/**
 * Retries `fn` with backoff, building the `BreakerGateway` this call's
 * attempts share and, on terminal failure, normalizing the error,
 * recording it against the breaker when `countsTowardBreaker` allows it,
 * and logging it under `logLabel` before rethrowing. This is the
 * retry-loop wiring `run` and `runStream` used to duplicate almost
 * verbatim; only `fn` and `logLabel` differ between callers now.
 */
export async function runAttemptLoop<T>(params: RunAttemptLoopParams<T>): Promise<T> {
  const {
    fn,
    requestId,
    model,
    providerName,
    isFallback,
    supportsJsonObjectMode,
    breaker,
    budget,
    maxRetries,
    baseDelayMs,
    nonRetryableStatus,
    signal,
    onAttempt,
    middleware,
    middlewareTimeoutMs,
    logger,
    reportEvent,
    logLabel,
    redactText,
    countsTowardBreaker,
  } = params;

  const resolvedState = params.state ?? createMiddlewareStateBag();
  const attempts: RetryAttempt[] = [];
  const gateway = createBreakerGateway({
    breaker,
    requestId,
    model,
    providerName,
    isFallback,
    supportsJsonObjectMode,
    registeredMiddlewareNames: Object.freeze(middleware.map(idFor)),
  });

  // Set only when `budget.assertAvailable()` is what actually stopped a
  // retry, so the terminal error below can report *that*, not whichever
  // failure happened to be current when the budget ran out.
  let budgetExhaustedError: LLMError | undefined;

  try {
    return await retryWithBackoff({
      fn: (attempt, onRequest) => {
        budget?.recordAttempt(attempt > 0);
        return fn(attempt, onRequest, resolvedState, gateway);
      },
      maxRetries,
      signal,
      onAttempt,
      attempts,
      shouldRetryAttempt: (error, signal) => {
        if (!shouldRetry(error, nonRetryableStatus, extractStatus, signal)) return false;
        if (budget) {
          try {
            budget.assertAvailable();
          } catch (err) {
            budgetExhaustedError = err as LLMError;
            return false;
          }
        }
        return true;
      },
      recoverDelayForAttempt: (attempt, error) =>
        recoverDelay({
          requestId,
          model,
          attempt,
          error,
          state: resolvedState,
          signal,
          providerName,
          maxRetries,
          baseDelayMs,
          middleware,
          middlewareTimeoutMs,
          logger,
          reportEvent,
          buildEventContext: (requestId, model, attempt, signal, state) =>
            gateway.buildAttemptContext(attempt, signal, state),
          extractStatus,
          normalizeError,
          emitEvent,
        }),
      normalizeError,
    });
  } catch (error) {
    // `attempts` only holds prior attempts that were actually retried
    // past. It's `[]` when nothing was retried, so normalize that to
    // `undefined` per `LLMError.attempts`'s contract. `budgetExhaustedError`
    // still goes through `normalizeError` so it inherits that same
    // history: `normalizeError` fills in `attempts` on an already-built
    // `LLMError` without overwriting anything it already carries, so
    // this doesn't touch the error's own `type`/`code`.
    const normalized = normalizeError(
      budgetExhaustedError ?? error,
      signal,
      attempts.length > 0 ? attempts : undefined,
    );

    if (countsTowardBreaker(normalized)) {
      // `attempts` only holds prior attempts that were retried past (see
      // above), so the attempt that actually exhausted the retries/broke
      // the loop is one past that. `recordFailure` converts to 1-based
      // itself.
      gateway.recordFailure(attempts.length, signal, resolvedState, normalized.code);
    }

    logger.debug(`[VernLLM:${requestId}] ${logLabel}:\n${redactText(describeError(error))}`);

    throw normalized;
  }
}
