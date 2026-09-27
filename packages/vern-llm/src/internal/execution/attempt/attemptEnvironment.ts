import { prepareAttempt, type OnRequest } from '../utils/dispatch/attemptDispatch.utils.js';
import { isLimiterFailure } from '../utils/dispatch/rateLimitDispatch.utils.js';

import type { Logger } from '../../../logger.js';
import type { RateLimiterAdapter } from '../../../rateLimit.js';
import type { LLMError } from '../../../types/errors.js';
import type {
  CallParams,
  DetectSoftFailure,
  LLMClient,
  MiddlewareStateBag,
  VernLLMEvent,
  VernLLMMiddleware,
} from '../../../types/index.js';
import type { BreakerGateway } from '../circuitBreakerContext.js';
import type { RequestBuilder } from '../requestBuilder.js';
import type { FinalizeResponseDeps } from '../responseFinalizer.js';
import type { UsageReporter } from '../usageReporter.js';
import type { DispatchHook } from '../utils/middleware/middleware.utils.js';

/** One target's fixed settings for a single attempt, built once per `CallExecutor`. */
export interface AttemptEnvironment {
  client: LLMClient;
  providerName: string;
  isFallback: boolean;
  timeoutMs: number;
  chunkIdleTimeoutMs: number;
  readerStallTimeoutMs?: number;
  maxRetryAfterMs: number;
  parseJson: (content: string) => unknown;
  logger: Logger;
  redact?: (text: string) => string;
  usageReporter: UsageReporter;
  reportEvent: (event: VernLLMEvent) => void;
  limiter?: RateLimiterAdapter;
  requestBuilder: RequestBuilder;
  middleware: VernLLMMiddleware[];
  dispatchHooks: readonly DispatchHook[];
  middlewareTimeoutMs: number;
  detectSoftFailure?: DetectSoftFailure;
}

/** What changes from one attempt to the next. */
export interface AttemptArgs<T> {
  params: CallParams<T>;
  requestId: string;
  attempt: number;
  onRequest: OnRequest | undefined;
  middlewareState: MiddlewareStateBag | undefined;
  gateway: BreakerGateway;
}

export function prepareTargetAttempt<T>(env: AttemptEnvironment, args: AttemptArgs<T>) {
  return prepareAttempt({
    ...args,
    requestBuilder: env.requestBuilder,
    providerName: env.providerName,
    limiter: env.limiter,
    middleware: env.middleware,
    dispatchHooks: env.dispatchHooks,
    middlewareTimeoutMs: env.middlewareTimeoutMs,
    logger: env.logger,
    reportEvent: env.reportEvent,
  });
}

export function redactText(env: AttemptEnvironment, text: string): string {
  return env.redact ? env.redact(text) : text;
}

export function finalizeDependencies(
  env: AttemptEnvironment,
  gateway: BreakerGateway,
  model: string,
): FinalizeResponseDeps {
  return {
    gateway,
    usageReporter: env.usageReporter,
    logger: env.logger,
    redactText: (text) => redactText(env, text),
    parseJson: env.parseJson,
    detectSoftFailure: env.detectSoftFailure,
    providerName: env.providerName,
    isFallback: env.isFallback,
    model,
  };
}

/**
 * Whether a failed attempt counts toward the breaker. Response defects, caller
 * mistakes, quota rejections and anything the limiter threw say nothing about
 * provider health, so they are excluded.
 */
export function countsTowardBreaker(error: LLMError): boolean {
  return error.countsTowardBreaker && !isLimiterFailure(error);
}
