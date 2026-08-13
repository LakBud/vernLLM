import type { CircuitState } from '../circuitBreaker.js';
import type { LLMError } from './errors.js';

/**
 * Reports what happened during a call. Fire and forget, mirroring
 * `onUsage`: the return value is never read and a throwing handler cannot
 * change what the call does, only what gets reported about it.
 */
export type VernLLMEvent =
  | {
      kind: 'retry';
      requestId: string;
      provider: string;
      /** The model actually resolved for this call (honors a per-call `model` override). */
      model: string;
      /** The 1-based retry ordinal (the 1st retry is `1`, not the overall attempt count). */
      attempt: number;
      maxRetries: number;
      delayMs: number;
      retryAfterHonored: boolean;
      error: LLMError;
    }
  | {
      kind: 'circuit_state';
      provider: string;
      /**
       * The model of the call that triggered this specific transition
       * (whatever was passed to the `assertClosed`/`recordSuccess`/
       * `recordFailure` call that caused it), not a property of the
       * circuit itself: the breaker still counts failures across every
       * model together, so a threshold crossing can be the sum of
       * several different models' failures even though only the
       * triggering call's `model` is reported here.
       */
      model: string;
      from: CircuitState;
      to: CircuitState;
      consecutiveFailures: number;
    }
  | {
      kind: 'fallback';
      requestId: string;
      /** Provider name of the target that just failed. */
      from: string;
      /** Provider name of the target about to be tried next. */
      to: string;
      /** `-1` for the primary target, otherwise the index into `fallback`. */
      fromIndex: number;
      toIndex: number;
      /** The normalized error that caused `from` to be abandoned. */
      error: LLMError;
      /** Time spent on `from`, including its own retries, before giving up. */
      elapsedMs: number;
    }
  | {
      kind: 'rate_limited';
      requestId: string;
      provider: string;
      /** The model actually resolved for this call (honors a per-call `model` override). */
      model: string;
      /** How long this attempt sat queued for capacity before it was let through. */
      waitedMs: number;
      /** Which configured bucket was blocking this attempt just before it cleared. */
      reason: 'concurrency' | 'rpm' | 'tpm';
    };

export type OnEvent = (event: VernLLMEvent) => void;
