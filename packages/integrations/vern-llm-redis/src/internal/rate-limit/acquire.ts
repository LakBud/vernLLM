import { LLMError, type RateLimitAcquireResult } from 'vern-llm';

import { toRedisError } from '../shared/errors/redisError.utils.js';
import { sleepOrAbort, waitForWakeOrPoll } from './sleep.utils.js';

import type { Bucket } from './buckets.utils.js';
import type { WaiterRegistry } from './waiterRegistry.utils.js';

/** Cap on one sleep, so a slow rate still reacts to an AIMD grow. */
const MAX_WAKE_DELAY_MS = 5_000;

function queueTimeout(): LLMError {
  return new LLMError('Rate limit queue timed out before capacity was available', 'rate_limited', {
    code: 'rate_limit_queue_timeout',
  });
}

export type TakeAttempt = { ok: true } | { ok: false; bucket: Bucket; waitMs: number };

/** What `acquire` needs from its adapter. */
export interface AcquirerDeps {
  buckets: Bucket[];
  tokensPerMinute: number | undefined;
  maxQueueMs: number;
  maxQueueSize: number;
  pollIntervalMs: number;
  queueLeaseMs: number;
  fairQueue: boolean;
  hasSubscriber: boolean;
  /** Settles once the wake subscription is live. */
  subscriptionReady?: Promise<void>;
  queueKey: string;
  waiterRegistry: WaiterRegistry;
  /** One op against the shared line. */
  queueOp(
    op: 'peek' | 'enter' | 'check' | 'leave',
    id: string,
  ): Promise<{ isHead: boolean; depth: number; full: boolean }>;
  tryTakeAll(estimatedTokens: number, leaseId: string): Promise<TakeAttempt>;
  startHeartbeat(bucket: Bucket, leaseId: string): () => void;
  makeRelease(
    estimatedTokens: number,
    leaseId: string,
    stopHeartbeat: (() => void) | undefined,
  ): RateLimitAcquireResult['release'];
  reportRejection(operation: string, error: unknown): void;
}

/** Builds `acquire`: waits, in the shared line if fair, until every bucket has room. Fails with an LLMError. */
export function createAcquirer(
  deps: AcquirerDeps,
): (estimatedTokens: number, signal?: AbortSignal) => Promise<RateLimitAcquireResult> {
  const { buckets, maxQueueMs, maxQueueSize, pollIntervalMs, fairQueue, queueKey } = deps;

  /** True once the subscription has settled. */
  let subscribed = deps.subscriptionReady === undefined;
  void deps.subscriptionReady?.then(() => {
    subscribed = true;
  });

  /** Longest sleep, so a waiter renews its place well inside `queueLeaseMs`. */
  const maxSleepMs = Math.max(1, Math.floor(deps.queueLeaseMs / 3));

  return async function acquire(estimatedTokens, signal): Promise<RateLimitAcquireResult> {
    if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
      throw new LLMError(
        `Rate limit acquire called with an invalid estimatedTokens value: ${estimatedTokens}`,
        'invalid_params',
      );
    }

    // A release published before subscribing is lost. Wait, bounded by the poll.
    if (!subscribed && deps.subscriptionReady) {
      await Promise.race([
        deps.subscriptionReady,
        sleepOrAbort(Math.min(pollIntervalMs, maxSleepMs), signal),
      ]);
    }

    // tokensPerMinute never grows, so an estimate above it can never fit.
    if (
      deps.tokensPerMinute !== undefined &&
      deps.tokensPerMinute > 0 &&
      estimatedTokens > deps.tokensPerMinute
    ) {
      throw new LLMError(
        `Estimated tokens (${estimatedTokens}) exceed the fixed tokensPerMinute capacity (${deps.tokensPerMinute}); this request can never be satisfied`,
        'rate_limited',
        { code: 'rate_limit_capacity_exceeded' },
      );
    }

    const startedAt = Date.now();
    const leaseId = globalThis.crypto.randomUUID();
    const call = {
      lastReason: undefined as Bucket['reason'] | undefined,
      inLine: false,
    };

    /** Joins the shared line, which also counts toward `maxQueueSize`. */
    async function enterLine(): Promise<void> {
      if ((await deps.queueOp('enter', leaseId)).full) {
        throw new LLMError('Rate limit queue is full', 'rate_limited', {
          code: 'rate_limit_queue_full',
        });
      }
      call.inLine = true;
    }

    try {
      while (true) {
        if (signal?.aborted) {
          throw new LLMError('Rate limit wait aborted', 'aborted');
        }

        if (fairQueue) {
          if (!call.inLine) {
            // Join behind anyone already waiting.
            if ((await deps.queueOp('peek', leaseId)).depth > 0) await enterLine();
          }

          if (call.inLine) {
            const { isHead } = await deps.queueOp('check', leaseId);

            if (!isHead) {
              const wait = Math.min(pollIntervalMs, maxSleepMs);
              if (deps.hasSubscriber) {
                await waitForWakeOrPoll(deps.waiterRegistry, queueKey, wait, signal);
              } else {
                await sleepOrAbort(wait, signal);
              }

              if (maxQueueMs > 0 && Date.now() - startedAt >= maxQueueMs) {
                throw queueTimeout();
              }
              continue;
            }
          }
        } else if (call.inLine) {
          // In line only to be counted: keep the place from lapsing.
          await deps.queueOp('check', leaseId);
        }

        const attempt = await deps.tryTakeAll(estimatedTokens, leaseId);
        if (attempt.ok) {
          const concurrency = buckets.find((b) => b.reason === 'concurrency');
          const stopHeartbeat = concurrency ? deps.startHeartbeat(concurrency, leaseId) : undefined;

          return {
            release: deps.makeRelease(estimatedTokens, leaseId, stopHeartbeat),
            waitedMs: Date.now() - startedAt,
            reason: call.lastReason,
          };
        }

        call.lastReason = attempt.bucket.reason;

        // Only a waiting call joins the line, and without fairQueue only to be counted.
        if (!call.inLine && (fairQueue || maxQueueSize > 0)) {
          await enterLine();
          // A release may have landed meanwhile: look again.
          if (fairQueue) continue;
        }

        const elapsed = Date.now() - startedAt;
        if (maxQueueMs > 0 && elapsed >= maxQueueMs) {
          throw queueTimeout();
        }

        // Also capped by the remaining maxQueueMs, so a timeout is caught promptly.
        const remainingBudget = maxQueueMs > 0 ? maxQueueMs - elapsed : Infinity;

        if (attempt.waitMs >= 0) {
          // Per minute buckets refill on a schedule: sleep exactly that long.
          const delay = Math.min(
            Math.max(1, Math.ceil(attempt.waitMs)),
            MAX_WAKE_DELAY_MS,
            maxSleepMs,
            Math.max(1, remainingBudget),
          );
          await sleepOrAbort(delay, signal);
        } else if (deps.hasSubscriber) {
          // Concurrency only frees on a release: wake on it, or the poll.
          await waitForWakeOrPoll(
            deps.waiterRegistry,
            attempt.bucket.key,
            Math.min(pollIntervalMs, maxSleepMs),
            signal,
          );
        } else {
          await sleepOrAbort(
            Math.min(pollIntervalMs, maxSleepMs, Math.max(1, remainingBudget)),
            signal,
          );
        }
      }
    } catch (error) {
      throw toRedisError('acquire', error);
    } finally {
      // Best effort: a lapsed lease clears the place anyway if this fails.
      if (call.inLine) {
        await deps
          .queueOp('leave', leaseId)
          .catch((error: unknown) => deps.reportRejection('queue leave', error));
      }
    }
  };
}
