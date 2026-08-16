import { LLMError } from './errors.js';

import type { CircuitBreakerOptions, CircuitState } from '../circuitBreaker.js';
import type { RateLimitOptions } from '../rateLimit.js';
import type { LLMClient } from './client.js';

/**
 * One provider to try after the primary (or after an earlier fallback
 * target) fails. Order is the policy: VernLLM never reorders, scores, or
 * selects a target, it only walks the list as given.
 *
 * Most per-target overrides fall back to the parent `VernLLM` instance's
 * own option when omitted, so a target only needs to specify what's
 * actually different about it (a different client/model is the common
 * case). `circuitBreaker` and `rateLimit` are the exception: they are
 * never inherited from the parent, since a breaker or limiter tuned for
 * the primary provider's limits is rarely right for a fallback's. Leave
 * them unset on a target to run it without one, even if the parent has
 * one configured.
 */
export interface FallbackTarget {
  client: LLMClient;
  model: string;
  /** Label for events, errors, and `TokenUsage.provider`. Default `` `fallback[${index}]` ``. */
  name?: string;

  maxRetries?: number;
  timeoutMs?: number;
  chunkIdleTimeoutMs?: number;
  baseDelayMs?: number;
  defaultMaxTokens?: number;
  defaultTemperature?: number | null;
  nonRetryableStatus?: number[];
  /** This target's own circuit breaker, independent of every other target's. Not inherited from the parent's `circuitBreaker`. */
  circuitBreaker?: boolean | CircuitBreakerOptions;
  /** This target's own rate limiter, independent of every other target's. Not inherited from the parent's `rateLimit`. */
  rateLimit?: RateLimitOptions;
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

/** One target's failure, recorded on the way to either the next target or `FallbackExhaustedError`. */
export interface FallbackAttempt {
  /** `-1` for the primary target. */
  index: number;
  provider: string;
  model: string;
  error: LLMError;
}

/**
 * Decides what happens after a target's own retries are exhausted or
 * abandoned early. Called once per failed target. `'retry'` is not a
 * valid return here: retrying already happened inside the target, this
 * only decides whether to move on to the next one or stop.
 */
export type FallbackOn = (error: LLMError, context: { isLastTarget: boolean }) => 'next' | 'stop';

/** Tool contract failures are the model ignoring the request, not a sick provider: repeating it elsewhere can't help. */
const TOOL_CONTRACT_CODES = new Set(['unknown_tool', 'duplicate_tool_call_id']);

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

  return 'next';
};

/**
 * Thrown when the chain gives up, whether because the last target failed
 * or `fallbackOn` chose to stop early. Carries each attempt in order so
 * an outage across providers stays debuggable without reproducing it.
 * Extends `LLMError` so `isLLMError` and any `instanceof LLMError` check
 * still passes, inheriting the last failure's `type`/`status`/`retryAfterMs`
 * so existing type-based handling, including reading `retryAfterMs` on an
 * `'api'`-typed error, keeps working on a fallback-exhausted error too.
 */
export class FallbackExhaustedError extends LLMError {
  constructor(public readonly attempts: FallbackAttempt[]) {
    const last = attempts[attempts.length - 1]?.error;

    super(
      `${attempts.length} provider${attempts.length === 1 ? '' : 's'} attempted and failed: ${attempts
        .map((a) => `${a.provider}(${a.error.type})`)
        .join(' then ')}`,
      last?.type ?? 'unknown',
      last?.status,
      undefined,
      last,
      last?.retryAfterMs,
      'fallback_exhausted',
    );
  }
}
