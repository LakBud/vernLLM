import { LLMError, type RetryAttempt } from './errors.js';

import type { CircuitState } from '../circuitBreaker.js';
import type { RetryBudgetOptions } from '../internal/retryBudget.js';
import type { CircuitBreakerOption } from '../internal/utils/circuit-breaker/circuitBreakerAdapter.utils.js';
import type { RateLimitOption } from '../internal/utils/rate-limit/rateLimitAdapter.utils.js';
import type { DetectSoftFailure } from './call.js';
import type { LLMClient } from './client.js';

/**
 * A provider tried after the primary fails, in the order given. Omitted overrides fall back to the
 * instance's options, except `circuitBreaker`, `rateLimit` and `retryBudget`, which are never
 * inherited since limits tuned for the primary rarely fit a fallback.
 */
export interface FallbackTarget {
  client: LLMClient;
  model: string;
  /** Label for events, errors, and `TokenUsage.provider`. Default `` `fallback[${index}]` ``. */
  name?: string;

  maxRetries?: number;
  timeoutMs?: number;
  chunkIdleTimeoutMs?: number;
  readerStallTimeoutMs?: number;
  baseDelayMs?: number;
  maxRetryAfterMs?: number;
  defaultMaxTokens?: number;
  defaultTemperature?: number | null;
  defaultReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  defaultBudgetTokens?: number;
  nonRetryableStatus?: number[];
  /** This target's own breaker, or a shared `CircuitBreakerAdapter`. Not inherited from the parent's `circuitBreaker`. */
  circuitBreaker?: CircuitBreakerOption;
  /** This target's own rate limiter, independent of every other target's. Not inherited from the parent's `rateLimit`. */
  rateLimit?: RateLimitOption;
  /** This target's own retry budget, independent of every other target's. Not inherited from the parent's `retryBudget`. */
  retryBudget?: RetryBudgetOptions;
  /**
   * Reclassifies a successful result from this target as a failure. Inherits the instance's
   * `detectSoftFailure` when omitted.
   */
  detectSoftFailure?: DetectSoftFailure;
}

/**
 * Written into `CallParams['meta']` once `call()` resolves, so a caller
 * who wants provider identity on the same line as the result doesn't need
 * to read it back out of `onUsage`.
 */
export interface CallMeta {
  provider: string;
  model: string;
  /** `-1` if the primary target answered, otherwise the index into `fallback`. */
  fallbackIndex: number;
  usedFallback: boolean;
  /** Attempts made against the target that ultimately answered, including the successful one. */
  attempts: number;
}

/** One target's circuit state, as returned by `VernLLM.getCircuitStates()`. */
export interface TargetCircuitState {
  provider: string;
  /** Position in the chain: `0` for the primary, `1`+ for fallback targets. */
  index: number;
  isFallback: boolean;
  /** Whether this target tracks failures per model. `false` means `model` on `getCircuitStates` had no effect on this entry. */
  isolateByModel: boolean;
  /** `undefined` if that target has no circuit breaker configured. */
  state: CircuitState | undefined;
}

/** Which target/model `VernLLM.getCircuitState`, `openCircuit`, and `closeCircuit` act on. */
export interface CircuitTarget {
  /** Which target to act on. `0` is the primary, `1`+ are fallbacks. Defaults to `0`. */
  index?: number;
  /** Which model bucket to act on, if the resolved target isolates by model. */
  model?: string;
}

/**
 * One target's failure. `index` is `-1` for the primary; `provider` and `model` name the target.
 */
export interface FallbackAttempt extends RetryAttempt {
  provider: string;
  model: string;
}

/**
 * Whether to try the next target (`'next'`) or give up (`'stop'`) after a target's own retries.
 * Called once per failed target.
 */
export type FallbackOn = (error: LLMError, context: { isLastTarget: boolean }) => 'next' | 'stop';

/**
 * Tool contract failures another provider can't fix. Most are the model ignoring the request;
 * `duplicate_tool_call_id` is a provider protocol violation, but equally not something a fallback
 * would change.
 */
const TOOL_CONTRACT_CODES = new Set([
  'unknown_tool',
  'duplicate_tool_call_id',
  'tool_choice_none_violated',
  'unexpected_tool_calls',
]);

/**
 * The default `fallbackOn` policy. Exported so a caller can wrap rather
 * than replace it, e.g. `fallbackOn: (e, ctx) => myCheck(e) ? 'stop' : defaultFallbackOn(e, ctx)`.
 */
export const defaultFallbackOn: FallbackOn = (error) => {
  if (error.type === 'parse' || error.type === 'validation' || error.type === 'aborted') {
    return 'stop';
  }

  if (error.type === 'quota_exceeded') return 'stop';

  if (error.code && TOOL_CONTRACT_CODES.has(error.code)) return 'stop';

  // Caller input is rejected locally before any provider sees it, so every
  // target would reject it the same way. `unsupported_capability` is the
  // exception: it's one adapter's limit, and another target may support it.
  if (error.type === 'invalid_params' && error.code !== 'unsupported_capability') return 'stop';

  return 'next';
};

/**
 * Thrown when the chain gives up, carrying every attempt in order. Extends `LLMError` and takes the
 * last failure's `type`, `status` and `retryAfterMs`, so existing handling keeps working.
 */
export class FallbackExhaustedError extends LLMError {
  constructor(public override readonly attempts: FallbackAttempt[]) {
    const last = attempts[attempts.length - 1]?.error;

    // `type` is always `'fallback_exhausted'`, never inherited from the last
    // target's own type: every target failing is a meaningfully different
    // event from any single target's own failure. `status` and
    // `retryAfterMs` still inherit from the last attempt.
    super(
      `${attempts.length} provider${attempts.length === 1 ? '' : 's'} attempted and failed: ${attempts
        .map((a) => `${a.provider}(${a.error.type})`)
        .join(' then ')}`,
      'fallback_exhausted',
      {
        status: last?.status,
        // `last` is an `LLMErrorSnapshot`, not the live `LLMError` that
        // target actually threw, so `cause` here is the same descriptive
        // data a caller would get from `err.attempts.at(-1)!.error`
        // rather than a distinct object.
        cause: last,
        retryAfterMs: last?.retryAfterMs,
        code: 'fallback_exhausted',
        attempts,
      },
    );
  }

  /**
   * Defers to the last attempt's `retryable`, since `fallback_exhausted` alone says nothing about
   * it.
   */
  override get retryable(): boolean {
    const last = this.attempts[this.attempts.length - 1]?.error;
    return last ? last.retryable : super.retryable;
  }
}

/** Narrows `err` to {@link FallbackExhaustedError}, for direct access to its `attempts` (`provider`/`model` per failed target) without a manual `instanceof` check. */
export function isFallbackExhaustedError(err: unknown): err is FallbackExhaustedError {
  return err instanceof FallbackExhaustedError;
}

/**
 * An empty holder for `CallParams['meta']`, so `call()`'s `CallMeta` can be read without declaring
 * one by hand.
 *
 * @example
 * const meta = metaRef();
 * const result = await vern.call({ userContent: '...', meta });
 * meta.current?.provider;
 */
export function metaRef(): { current?: CallMeta } {
  return {};
}
