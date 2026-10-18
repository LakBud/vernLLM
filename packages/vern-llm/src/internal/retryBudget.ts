import { LLMError } from '../types/errors.js';
import { RollingRatio } from './rollingRatio.js';
import { validateMinCalls, validateRatio } from './utils/validate.utils.js';

import type { Logger } from '../logger.js';

/**
 * `windowMs` and `minCalls` work as in `RollingTripping`: `minCalls` keeps a cold start from
 * tripping. `retryRatio` is the largest share of calls in the window that may be retries. Invalid
 * values throw `RangeError` at construction.
 */
export interface RetryBudgetOptions {
  windowMs: number;
  minCalls: number;
  retryRatio: number;
}

/** Traffic and retry ratio in a budget's trailing window. */
export interface RetryBudgetSnapshot {
  attempts: number;
  retryRatio: number;
}

/**
 * What `retryBudget` accepts in place of options, e.g. a budget shared across processes. Both
 * required methods run on the call path and are synchronous: keep remote state in a local copy.
 */
export interface RetryBudgetAdapter {
  /**
   * Throws an `LLMError` when no retry may run, normally `type: 'rate_limited'` with
   * `code: 'retry_budget_exhausted'`. Anything else it throws is logged and the retry goes ahead.
   */
  assertAvailable(): void;
  /** `isRetry` is false for a call's first attempt. Fire and forget: a returned rejection is logged. */
  recordAttempt(isRetry: boolean): void;
  /** Read by `VernLLM.getRetryBudgetState()`. */
  getSnapshot?(): RetryBudgetSnapshot;
  /** Live counterpart of `getSnapshot`, read by `VernLLM.readRetryBudgetState()`. */
  readState?(): Promise<RetryBudgetSnapshot>;
  /** Receives the instance's `Logger` once, when `VernLLM` wires this adapter in. */
  setLogger?(logger: Logger): void;
}

/**
 * Caps the share of a target's recent traffic that may be retries. The breaker asks whether the
 * provider is healthy; this asks whether retrying is still worth the capacity it costs.
 */
export class RetryBudget implements RetryBudgetAdapter {
  private readonly ratio: RollingRatio;

  constructor(private readonly options: RetryBudgetOptions) {
    this.ratio = new RollingRatio(options.windowMs);
    validateMinCalls(options.minCalls);
    validateRatio(options.retryRatio, 'retryRatio');
  }

  /**
   * Throws `LLMError('retry_budget_exhausted')` once at least `minCalls`
   * calls have landed in the trailing `windowMs` and the retry ratio
   * among them has reached `retryRatio`. A no-op otherwise.
   */
  assertAvailable(): void {
    if (
      this.ratio.getCount() >= this.options.minCalls &&
      this.ratio.getRatio() >= this.options.retryRatio
    ) {
      throw new LLMError('Retry budget exhausted', 'rate_limited', {
        code: 'retry_budget_exhausted',
      });
    }
  }

  /** Records one attempt. `isRetry` is false for a call's first attempt, true for every attempt after it. */
  recordAttempt(isRetry: boolean): void {
    this.ratio.record(isRetry);
  }

  /** Current traffic and retry ratio in the trailing window. */
  getSnapshot(): RetryBudgetSnapshot {
    return { attempts: this.ratio.getCount(), retryRatio: this.ratio.getRatio() };
  }
}
