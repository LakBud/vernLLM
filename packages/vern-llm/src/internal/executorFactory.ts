import { RateLimiter } from '../rateLimit.js';
import { CallExecutor } from './execution/callExecutor.js';
import { buildCircuitBreaker } from './utils/circuitBreaker.utils.js';

import type { Logger } from '../logger.js';
import type { LLMError } from '../types/errors.js';
import type { FallbackTarget } from '../types/fallback.js';
import type { TokenUsage, VernLLMEvent, VernLLMMiddleware } from '../types/index.js';

/**
 * Everything `buildExecutors` needs beyond the targets themselves:
 * `VernLLM`'s own resolved shared defaults (the primary's own
 * `defaultTemperature`/`defaultReasoningEffort`/`defaultBudgetTokens`,
 * already resolved once by the caller, not the raw possibly-undefined
 * options) plus the plain `VernLLMOptions` knobs every target falls back
 * to when it doesn't set its own.
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
  baseDelayMs?: number;
  defaultMaxTokens?: number;
  nonRetryableStatus?: number[];
  parseJson?: (content: string) => unknown;
  redact?: (text: string) => string;
  onUsage?: (usage: TokenUsage) => void;
  onUsageFailure?: (usage: TokenUsage, error: LLMError) => void;
  onEvent?: (event: VernLLMEvent) => void;
  logger: Logger;
  middleware: VernLLMMiddleware[];
  middlewareTimeoutMs: number;
}

/**
 * Builds one `CallExecutor` per provider target: `primaryTarget` first,
 * then `declaredFallbacks` in order, matching `FallbackAttempt.index`
 * (`-1` for the primary). Each target's own option inherits from
 * `shared` only when the target itself leaves it unset; a target's
 * `circuitBreaker`/`rateLimit` are always its own, never inherited (see
 * `FallbackTarget`'s docs).
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
    );

    return new CallExecutor(name, target.client, target.model, {
      maxRetries: target.maxRetries ?? shared.maxRetries ?? 1,
      timeoutMs: target.timeoutMs ?? shared.timeoutMs ?? 25_000,
      chunkIdleTimeoutMs: target.chunkIdleTimeoutMs ?? shared.chunkIdleTimeoutMs ?? 30_000,
      baseDelayMs: target.baseDelayMs ?? shared.baseDelayMs ?? 500,
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
        shared.nonRetryableStatus ?? [400, 401, 403, 404, 422],
      parseJson: shared.parseJson,
      logger: shared.logger,
      redact: shared.redact,
      onUsage: shared.onUsage,
      onUsageFailure: shared.onUsageFailure,
      onEvent: shared.onEvent,
      breaker,
      limiter: target.rateLimit ? new RateLimiter(target.rateLimit) : undefined,
      isFallback,
      middleware: shared.middleware,
      middlewareTimeoutMs: shared.middlewareTimeoutMs,
    });
  });
}
