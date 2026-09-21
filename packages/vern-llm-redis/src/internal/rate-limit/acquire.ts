import { LLMError, type RateLimitAcquireResult } from 'vern-llm';

import { sleepOrAbort, waitForWakeOrPoll } from './sleep.utils.js';

import type { Bucket } from './buckets.utils.js';
import type { WaiterRegistry } from './waiterRegistry.utils.js';

/** Longest a single computed wait is ever slept before re-checking, so a very low rate never schedules a multi-minute timer that can't react to a meanwhile AIMD grow. */
const MAX_WAKE_DELAY_MS = 5_000;

function queueTimeout(): LLMError {
  return new LLMError('Rate limit queue timed out before capacity was available', 'rate_limited', {
    code: 'rate_limit_queue_timeout',
  });
}

export type TakeAttempt = { ok: true } | { ok: false; bucket: Bucket; waitMs: number };

/** Everything `acquire` needs from its adapter, passed in so the wait loop stays a plain function of its inputs. */
export interface AcquirerDeps {
  buckets: Bucket[];
  tokensPerMinute: number | undefined;
  maxQueueMs: number;
  maxQueueSize: number;
  pollIntervalMs: number;
  queueLeaseMs: number;
  fairQueue: boolean;
  hasSubscriber: boolean;
  /** Settles once the wake subscription is live. Waiting for it stops a release from being missed right after startup. */
  subscriptionReady?: Promise<void>;
  queueKey: string;
  waiterRegistry: WaiterRegistry;
  /** One op against the shared FIFO line, `id` being this call's own lease id. */
  queueOp(
    op: 'peek' | 'enter' | 'check' | 'leave',
    id: string,
  ): Promise<{ isHead: boolean; depth: number }>;
  tryTakeAll(estimatedTokens: number, leaseId: string): Promise<TakeAttempt>;
  startHeartbeat(bucket: Bucket, leaseId: string): () => void;
  makeRelease(
    estimatedTokens: number,
    leaseId: string,
    stopHeartbeat: (() => void) | undefined,
  ): RateLimitAcquireResult['release'];
  reportRejection(operation: string, error: unknown): void;
}

/**
 * Builds the `acquire` an adapter hands to VernLLM: waits, in the shared
 * fair line when there is one, until every bucket has capacity, then
 * returns the release for the slot it took.
 *
 * Every failure is an `LLMError` a caller can branch on: `invalid_params`
 * for a bad estimate, `aborted` for the caller's signal, and `rate_limited`
 * with `rate_limit_capacity_exceeded`, `rate_limit_queue_full` or
 * `rate_limit_queue_timeout`.
 */
export function createAcquirer(
  deps: AcquirerDeps,
): (estimatedTokens: number, signal?: AbortSignal) => Promise<RateLimitAcquireResult> {
  const { buckets, maxQueueMs, maxQueueSize, pollIntervalMs, fairQueue, queueKey } = deps;

  /** Calls waiting for capacity in this process right now, for `maxQueueSize`. */
  let waiting = 0;

  /** True once the wake subscription has settled, so later calls skip the wait entirely. */
  let subscribed = deps.subscriptionReady === undefined;
  void deps.subscriptionReady?.then(() => {
    subscribed = true;
  });

  /** Longest any single sleep may last, so a waiter always renews its place in line well inside `queueLeaseMs`. */
  const maxSleepMs = Math.max(1, Math.floor(deps.queueLeaseMs / 3));

  return async function acquire(estimatedTokens, signal): Promise<RateLimitAcquireResult> {
    if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
      throw new LLMError(
        `Rate limit acquire called with an invalid estimatedTokens value: ${estimatedTokens}`,
        'invalid_params',
      );
    }

    // A release published before the subscription is live is lost, and the
    // waiter would then only wake on the poll. Wait for it, bounded by the
    // poll interval so a hung subscribe can never stall a call.
    if (!subscribed && deps.subscriptionReady) {
      await Promise.race([
        deps.subscriptionReady,
        sleepOrAbort(Math.min(pollIntervalMs, maxSleepMs), signal),
      ]);
    }

    // tokensPerMinute is a fixed cap, never grown by AIMD (only rpm
    // is), so a request estimated above it can never succeed no
    // matter how long it waits. Fail fast instead of retrying it
    // silently until maxQueueMs times out.
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
      queued: false,
      inLine: false,
    };

    /** Counts this call as waiting, rejecting it if this process already has `maxQueueSize` waiting. Runs once, the first time the call actually has to wait. */
    function startWaiting(): void {
      if (call.queued) return;
      if (maxQueueSize > 0 && waiting >= maxQueueSize) {
        throw new LLMError('Rate limit queue is full', 'rate_limited', {
          code: 'rate_limit_queue_full',
        });
      }
      call.queued = true;
      waiting += 1;
    }

    try {
      while (true) {
        if (signal?.aborted) {
          throw new LLMError('Rate limit wait aborted', 'aborted');
        }

        if (fairQueue) {
          if (!call.inLine) {
            // Anyone already waiting goes first: join behind them rather
            // than taking capacity out from under them.
            if ((await deps.queueOp('peek', leaseId)).depth > 0) {
              startWaiting();
              await deps.queueOp('enter', leaseId);
              call.inLine = true;
            }
          }

          if (call.inLine) {
            const { isHead } = await deps.queueOp('check', leaseId);

            if (!isHead) {
              // Woken when the line advances, or by the poll as a backstop.
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

        // Only a call that actually has to wait counts against the
        // queue, an uncontended one never does.
        startWaiting();
        if (fairQueue && !call.inLine) {
          await deps.queueOp('enter', leaseId);
          call.inLine = true;
          // A release may have landed during that round trip, before this
          // call was listening for its wake. Look again instead of sleeping.
          continue;
        }

        const elapsed = Date.now() - startedAt;
        if (maxQueueMs > 0 && elapsed >= maxQueueMs) {
          throw queueTimeout();
        }

        // Cap every wait by the remaining maxQueueMs budget too, not
        // just MAX_WAKE_DELAY_MS, so a timeout is caught within one
        // short beat of the deadline instead of only after a full
        // capped sleep has already elapsed past it.
        const remainingBudget = maxQueueMs > 0 ? maxQueueMs - elapsed : Infinity;

        if (attempt.waitMs >= 0) {
          // requests/min or tokens/min: refill time is deterministic,
          // sleep exactly that long instead of polling blind.
          const delay = Math.min(
            Math.max(1, Math.ceil(attempt.waitMs)),
            MAX_WAKE_DELAY_MS,
            maxSleepMs,
            Math.max(1, remainingBudget),
          );
          await sleepOrAbort(delay, signal);
        } else if (deps.hasSubscriber) {
          // concurrency: only an external release clears this, wake on
          // that release's notification (or pollIntervalMs, whichever first).
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
    } finally {
      if (call.queued) waiting -= 1;
      // Best effort: a lapsed lease clears the place anyway if this fails.
      if (call.inLine) {
        await deps
          .queueOp('leave', leaseId)
          .catch((error: unknown) => deps.reportRejection('queue leave', error));
      }
    }
  };
}
