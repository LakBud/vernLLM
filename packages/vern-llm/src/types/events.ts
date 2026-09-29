import type { CircuitState } from '../circuitBreaker.js';
import type { CallContext, JsonValue } from './call.js';
import type { LLMError } from './errors.js';
import type { TokenUsage } from './usage.js';

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
      context?: CallContext;
    }
  | {
      kind: 'circuit_state';
      provider: string;
      /**
       * The model of the call that triggered this transition. Without `isolateByModel` the count
       * spans every model, so the threshold may have been reached by several.
       */
      model: string;
      from: CircuitState;
      to: CircuitState;
      consecutiveFailures: number;
      context?: CallContext;
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
      context?: CallContext;
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
      context?: CallContext;
    }
  | {
      kind: 'middleware';
      requestId: string;
      /** This middleware's `name`, or its array position if unnamed. */
      middleware: string;
      hook: 'transform' | 'wrap_short_circuit' | 'enabled_skip';
      /** For `hook: 'transform'` only: which top-level fields the merged patch touched. */
      patchedFields?: string[];
      context?: CallContext;
    }
  | {
      /**
       * Reported once a call fully succeeds. Same data `VernLLMOptions.onUsage`
       * receives; that option is sugar over this event, not a second
       * reporting path, see `makeEventReporter`.
       */
      kind: 'usage';
      requestId: string;
      usage: TokenUsage;
      context?: CallContext;
    }
  | {
      /**
       * A response carried usage and post-processing then failed. Once per such attempt;
       * `onUsageFailure` is driven from this event.
       */
      kind: 'usage_failure';
      requestId: string;
      usage: TokenUsage;
      error: LLMError;
      context?: CallContext;
    }
  | {
      /** Reported by a middleware through `ctx.emit`. */
      kind: 'custom';
      requestId: string;
      /** Namespaced by convention, e.g. `router.decision`. */
      name: string;
      /** Label of the emitting middleware. */
      source: string;
      data?: JsonValue;
      context?: CallContext;
    };

export type OnEvent = (event: VernLLMEvent) => void;
