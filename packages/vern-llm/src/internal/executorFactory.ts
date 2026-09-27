import { CallExecutor } from './execution/callExecutor.js';
import { DEFAULT_MAX_DELAY_MS } from './execution/utils/retry/retry.utils.js';
import { RetryBudget } from './retryBudget.js';
import { resolveAdapterInfo } from './utils/adapterInfo.utils.js';
import { buildCircuitBreaker } from './utils/circuit-breaker/circuitBreakerAdapter.utils.js';
import { buildRateLimit } from './utils/rate-limit/rateLimitAdapter.utils.js';

import type { Logger } from '../logger.js';
import type { DetectSoftFailure } from '../types/call.js';
import type { LLMError } from '../types/errors.js';
import type { FallbackTarget } from '../types/fallback.js';
import type { TokenUsage, VernLLMEvent, VernLLMMiddleware } from '../types/index.js';

/**
 * What `buildExecutors` needs besides the targets: the primary's resolved defaults and the instance
 * options each target falls back to.
 */
export interface ExecutorFactoryShared {
  /** This instance's provider label, used as the primary target's name unless it sets its own. */
  providerName: string;
  /** The primary's resolved `defaultTemperature`. Fallback targets that don't set their own inherit this, not `undefined`. */
  primaryDefaultTemperature: number | null;
  primaryDefaultReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  primaryDefaultBudgetTokens?: number;
  maxRetries?: number;
  timeoutMs?: number;
  chunkIdleTimeoutMs?: number;
  readerStallTimeoutMs?: number;
  baseDelayMs?: number;
  maxRetryAfterMs?: number;
  defaultMaxTokens?: number;
  nonRetryableStatus?: number[];
  parseJson?: (content: string) => unknown;
  redact?: (text: string) => string;
  onUsage?: (usage: TokenUsage) => void;
  onUsageFailure?: (usage: TokenUsage, error: LLMError) => void;
  onEvent?: (event: VernLLMEvent) => void;
  logger: Logger;
  middleware: VernLLMMiddleware[];
  /** `wrap` nesting order, which `dispatch` hooks nest in too. */
  dispatchOrder?: VernLLMMiddleware[];
  middlewareTimeoutMs: number;
  detectSoftFailure?: DetectSoftFailure;
}

/**
 * One `CallExecutor` per target, primary first, then fallbacks in order. A target inherits an
 * option only when it leaves it unset; breaker and limiter are never inherited.
 */
export function buildExecutors(
  primaryTarget: FallbackTarget,
  declaredFallbacks: FallbackTarget[],
  shared: ExecutorFactoryShared,
): CallExecutor[] {
  const targets = [primaryTarget, ...declaredFallbacks];

  return targets.map((target, i) => {
    const isFallback = i > 0;
    // `-1` for the primary, matching `FallbackAttempt.index`.
    const name = target.name ?? (isFallback ? `fallback[${i - 1}]` : shared.providerName);

    // Built before the executor: onStateChange fires from inside the
    // breaker itself, which the executor is merely handed a reference to.
    const breaker = buildCircuitBreaker(
      target.circuitBreaker,
      name,
      target.model,
      shared.onEvent,
      shared.logger,
      shared.middleware,
      shared.middlewareTimeoutMs,
      isFallback,
      target.client.supportsJsonObjectMode ?? true,
      resolveAdapterInfo(target.client),
    );

    // Independent of `breaker`, never inherited from `shared`, same as
    // `circuitBreaker`/`rateLimit`: a budget tuned for one target's
    // capacity is rarely right for another's.
    const budget = target.retryBudget ? new RetryBudget(target.retryBudget) : undefined;

    return new CallExecutor(name, target.client, target.model, {
      maxRetries: target.maxRetries ?? shared.maxRetries ?? 1,
      timeoutMs: target.timeoutMs ?? shared.timeoutMs ?? 25_000,
      chunkIdleTimeoutMs: target.chunkIdleTimeoutMs ?? shared.chunkIdleTimeoutMs ?? 30_000,
      readerStallTimeoutMs: target.readerStallTimeoutMs ?? shared.readerStallTimeoutMs,
      baseDelayMs: target.baseDelayMs ?? shared.baseDelayMs ?? 500,
      maxRetryAfterMs: target.maxRetryAfterMs ?? shared.maxRetryAfterMs ?? DEFAULT_MAX_DELAY_MS,
      defaultMaxTokens: target.defaultMaxTokens ?? shared.defaultMaxTokens ?? 1000,
      defaultTemperature:
        target.defaultTemperature === undefined
          ? shared.primaryDefaultTemperature
          : target.defaultTemperature,
      defaultReasoningEffort:
        target.defaultReasoningEffort === undefined
          ? shared.primaryDefaultReasoningEffort
          : target.defaultReasoningEffort,
      defaultBudgetTokens:
        target.defaultBudgetTokens === undefined
          ? shared.primaryDefaultBudgetTokens
          : target.defaultBudgetTokens,
      nonRetryableStatus: target.nonRetryableStatus ??
        shared.nonRetryableStatus ?? [400, 401, 402, 403, 404, 413, 422],
      parseJson: shared.parseJson,
      logger: shared.logger,
      redact: shared.redact,
      onUsage: shared.onUsage,
      onUsageFailure: shared.onUsageFailure,
      onEvent: shared.onEvent,
      breaker,
      budget,
      limiter: buildRateLimit(target.rateLimit, shared.logger),
      isFallback,
      middleware: shared.middleware,
      dispatchOrder: shared.dispatchOrder,
      middlewareTimeoutMs: shared.middlewareTimeoutMs,
      detectSoftFailure: target.detectSoftFailure ?? shared.detectSoftFailure,
    });
  });
}
