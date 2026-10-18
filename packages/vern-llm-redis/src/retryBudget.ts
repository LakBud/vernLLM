import {
  LLMError,
  type RetryBudgetAdapter,
  type RetryBudgetOptions,
  type RetryBudgetSnapshot,
} from 'vern-llm';

import { resolveRetryBudgetOptions } from './internal/retry-budget/retryBudgetOptions.utils.js';
import {
  parseWindowReply,
  READ_SCRIPT,
  RECORD_SCRIPT,
  type WindowCounts,
} from './internal/retry-budget/scripts.js';
import { toRedisError } from './internal/shared/errors/redisError.utils.js';
import { createAdapterLogger, type AdapterLoggerOption } from './internal/shared/logger.utils.js';
import { withScriptCache } from './internal/shared/redis/scriptCache.utils.js';

import type { RedisClient } from './types.js';

export interface RedisRetryBudgetOptions extends RetryBudgetOptions {
  /** Prefix for the budget's key. Default "vernllm:rb". Give each target its own, or they share one budget. */
  keyPrefix?: string;
  /** Where background failures go. Defaults to the VernLLM logger. `'silent'` discards them. */
  logger?: AdapterLoggerOption;
}

/** A `RetryBudgetAdapter` with every optional member, plus `dispose`. */
export interface RedisRetryBudgetAdapter extends Required<RetryBudgetAdapter> {
  /** Mutes the logger and ignores replies still in flight. Call before closing the client. Idempotent. */
  dispose(): void;
}

function toSnapshot({ attempts, retries }: WindowCounts): RetryBudgetSnapshot {
  return { attempts, retryRatio: attempts === 0 ? 0 : retries / attempts };
}

/** A RetryBudgetAdapter backed by Redis, shared by every process using the same key. */
export function redisRetryBudget(
  client: RedisClient,
  options: RedisRetryBudgetOptions,
): RedisRetryBudgetAdapter {
  const redis = withScriptCache(client);
  const { windowMs, key, minCalls, retryRatio, bucketWidthMs, ttlMs } =
    resolveRetryBudgetOptions(options);
  const log = createAdapterLogger('redisRetryBudget', options.logger);
  let disposed = false;

  // This process's copy of the shared window, replaced by every reply. A reply covers every
  // attempt Redis ran before it, but not this process's records still in flight behind it, so
  // those are added back, or an early reply would hide a burst the local count had caught.
  let counts: WindowCounts = { attempts: 0, retries: 0 };
  let inFlight: WindowCounts = { attempts: 0, retries: 0 };
  let observedAt = Date.now();

  const add = (a: WindowCounts, b: WindowCounts, sign = 1): WindowCounts => ({
    attempts: a.attempts + sign * b.attempts,
    retries: a.retries + sign * b.retries,
  });

  const observe = (next: WindowCounts) => {
    if (disposed) return;
    counts = add(next, inFlight);
    observedAt = Date.now();
  };

  // A reply older than the window says nothing about it any more. Reading that as empty is what
  // makes a long Redis outage fail open instead of freezing the last verdict.
  const current = (): RetryBudgetSnapshot =>
    toSnapshot(Date.now() - observedAt > windowMs ? { attempts: 0, retries: 0 } : counts);

  return {
    assertAvailable() {
      const snapshot = current();
      // Core's rule, so a budget tuned in process behaves the same shared.
      if (snapshot.attempts >= minCalls && snapshot.retryRatio >= retryRatio) {
        throw new LLMError('Retry budget exhausted', 'rate_limited', {
          code: 'retry_budget_exhausted',
        });
      }
    },

    recordAttempt(isRetry) {
      if (disposed) return;
      const attempt = { attempts: 1, retries: isRetry ? 1 : 0 };
      counts = add(counts, attempt);
      inFlight = add(inFlight, attempt);
      // Once per record, whether Redis replies, rejects, or replies with something unreadable.
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        inFlight = add(inFlight, attempt, -1);
      };

      // Fire and forget: the reply lands while the provider call is still running, so the next
      // retry check reads near live totals without waiting on Redis.
      void redis
        .eval(RECORD_SCRIPT, 1, key, bucketWidthMs, isRetry ? 1 : 0, ttlMs)
        .then((reply) => {
          settle();
          observe(parseWindowReply(reply));
        })
        .catch((error: unknown) => {
          settle();
          log.failure('recordAttempt', error, key);
        });
    },

    /** What this process last saw, plus its own attempts since. */
    getSnapshot: current,

    async readState() {
      const live = await redis
        .eval(READ_SCRIPT, 1, key, bucketWidthMs)
        .then(parseWindowReply)
        .catch((error: unknown) => {
          throw toRedisError('readState', error);
        });

      observe(live);
      return toSnapshot(live);
    },

    setLogger(logger) {
      log.adopt(logger);
    },

    dispose() {
      disposed = true;
      log.mute();
    },
  };
}
