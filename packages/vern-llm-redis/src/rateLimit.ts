import {
  LLMError,
  defaultEstimateTokens,
  type RateLimitAcquireResult,
  type RateLimiterAdapter,
  type WireRequest,
} from 'vern-llm';

import { assertValidAimd, type AimdOptions } from './internal/rate-limit/aimd.utils.js';
import { amountFor, buildBuckets, type Bucket } from './internal/rate-limit/buckets.utils.js';
import {
  GIVE_SCRIPT,
  RESIZE_SCRIPT,
  TAKE_SCRIPT,
  parseTakeResult,
} from './internal/rate-limit/scripts.js';
import { sleepOrAbort, waitForWakeOrPoll } from './internal/rate-limit/sleep.utils.js';
import { createWaiterRegistry } from './internal/rate-limit/waiterRegistry.utils.js';

import type { RedisClient, RedisSubscriber } from './types.js';

export type { AimdOptions };

/**
 * Not exported by vern-llm's public entry point, so redefined here
 * structurally. Only remainingRequests is read, matching what
 * reactToRateLimitHint's built in AIMD path also relies on.
 */
interface ProviderRateLimitHint {
  remainingRequests?: number;
}

export interface RedisRateLimitOptions {
  /** Max requests per minute. Omit for unlimited. Also the AIMD ceiling's starting value when aimd is set. */
  requestsPerMinute?: number;
  /** Max tokens per minute, checked against a pre-flight estimate. Omit for unlimited. */
  tokensPerMinute?: number;
  /** Max requests in flight at once, shared across every process using this key. Omit for unlimited. */
  maxConcurrent?: number;
  /** Max time a call may wait for capacity before throwing, in ms. Default 30000. */
  maxQueueMs?: number;
  /**
   * Fallback poll interval, in ms, used only while waiting on the
   * concurrency bucket without a subscriber (see below). requests/min and
   * tokens/min waits never poll, they compute an exact wake delay from
   * live bucket state instead. Default 250.
   */
  pollIntervalMs?: number;
  estimateTokens?: (request: WireRequest) => number;
  /** Prefix for every Redis key this adapter writes. Default "vernllm:rl". */
  keyPrefix?: string;
  /**
   * AIMD against the requests-per-minute bucket, shared across every
   * process using this key: a shrink or growth from one process is seen
   * by every other process on their next take. Requires requestsPerMinute.
   */
  aimd?: AimdOptions;
  /**
   * A dedicated pub/sub connection (e.g. `mainClient.duplicate()`).
   * requests/min and tokens/min waits never need this, their wake time
   * is computed exactly from the refill rate. The concurrency bucket
   * only clears on an external release though, so without a subscriber
   * a concurrency wait falls back to polling every pollIntervalMs; with
   * one, it wakes within a few ms of the release that freed a slot.
   */
  subscriber?: RedisSubscriber;
}

/** Longest a single computed wait is ever slept before re-checking, so a very low rate never schedules a multi-minute timer that can't react to a meanwhile AIMD grow. */
const MAX_WAKE_DELAY_MS = 5_000;

/**
 * A RateLimiterAdapter backed by Redis, so request, token, concurrency,
 * and AIMD state are shared across every process using the same keys.
 *
 * Requests/min and tokens/min waits are precise: each computes exactly
 * how long until its bucket refills and sleeps that long, capped at
 * MAX_WAKE_DELAY_MS. A concurrency wait only clears via an external
 * release, so it wakes on that release's pub/sub notice (`subscriber`)
 * or falls back to polling (`pollIntervalMs`).
 */
export function redisRateLimit(
  redis: RedisClient,
  options: RedisRateLimitOptions = {},
): RateLimiterAdapter {
  const keyPrefix = options.keyPrefix ?? 'vernllm:rl';
  const maxQueueMs = options.maxQueueMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const estimateTokensFn = options.estimateTokens ?? defaultEstimateTokens;
  const wakeChannel = `${keyPrefix}:wake`;

  // 0 is meaningful (unlimited capacity for the three bucket options,
  // "wait forever" for maxQueueMs) and must be preserved, not rejected.
  // Only negative or non-finite values are actual config mistakes.
  for (const [name, value] of [
    ['requestsPerMinute', options.requestsPerMinute],
    ['tokensPerMinute', options.tokensPerMinute],
    ['maxConcurrent', options.maxConcurrent],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new LLMError(
        `${name} must be a finite number that is not negative (got ${value}).`,
        'invalid_params',
      );
    }
  }
  if (!Number.isFinite(maxQueueMs) || maxQueueMs < 0) {
    throw new LLMError(
      `maxQueueMs must be a finite number that is not negative (got ${maxQueueMs}).`,
      'invalid_params',
    );
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new LLMError(
      `pollIntervalMs must be a finite number greater than 0 (got ${pollIntervalMs}).`,
      'invalid_params',
    );
  }

  if (options.aimd) assertValidAimd(options.aimd, options.requestsPerMinute);
  const aimd = options.aimd;

  const { buckets, rpmBucket } = buildBuckets({
    keyPrefix,
    maxConcurrent: options.maxConcurrent,
    requestsPerMinute: options.requestsPerMinute,
    tokensPerMinute: options.tokensPerMinute,
  });

  // Waiters blocked on a specific key's concurrency bucket, woken by
  // GIVE_SCRIPT's PUBLISH the moment a slot frees, instead of polling.
  const waiterRegistry = createWaiterRegistry();

  if (options.subscriber) {
    void options.subscriber
      .subscribe(wakeChannel)
      .catch((error: unknown) =>
        console.error(`[redisRateLimit] subscribe failed for channel "${wakeChannel}":`, error),
      );
    options.subscriber.on('message', (channel, message) => {
      if (channel !== wakeChannel) return;
      waiterRegistry.wake(message);
    });
  }

  async function give(bucket: Bucket, amount: number): Promise<void> {
    await redis.eval(
      GIVE_SCRIPT,
      1,
      bucket.key,
      bucket.initialCapacity,
      amount,
      wakeChannel,
      bucket.rateMode,
    );
  }

  async function tryTakeAll(
    estimatedTokens: number,
  ): Promise<{ ok: true } | { ok: false; bucket: Bucket; waitMs: number }> {
    const taken: Bucket[] = [];

    for (const bucket of buckets) {
      const amount = amountFor(bucket, estimatedTokens);
      const result = parseTakeResult(
        await redis.eval(
          TAKE_SCRIPT,
          1,
          bucket.key,
          Date.now(),
          bucket.initialCapacity,
          bucket.rateMode,
          amount,
        ),
      );

      if (!result.ok) {
        for (const entry of taken) {
          await give(entry, amountFor(entry, estimatedTokens));
        }
        return { ok: false, bucket, waitMs: result.waitMs };
      }

      taken.push(bucket);
    }

    return { ok: true };
  }

  async function resize(op: 'grow' | 'shrink'): Promise<void> {
    if (!aimd || !rpmBucket) return;

    const amount = op === 'grow' ? aimd.increaseBy : aimd.decreaseFactor;
    await redis.eval(
      RESIZE_SCRIPT,
      1,
      rpmBucket.key,
      op,
      amount,
      aimd.minCapacity,
      aimd.maxCapacity,
      rpmBucket.initialCapacity,
    );
  }

  function makeRelease(
    estimatedTokens: number,
  ): (actualTokens?: number, success?: boolean) => void {
    let released = false;

    return (actualTokens?: number, success = false) => {
      if (released) return;
      released = true;

      const concurrency = buckets.find((b) => b.reason === 'concurrency');
      if (concurrency) void give(concurrency, 1);

      const tokens = buckets.find((b) => b.reason === 'tpm');
      if (
        tokens &&
        actualTokens !== undefined &&
        Number.isFinite(actualTokens) &&
        actualTokens >= 0
      ) {
        // diff > 0: less was actually used than reserved, refund the
        // unused portion. diff < 0: more was actually used than
        // reserved, charge the bucket the excess now so a caller that
        // under-estimated doesn't silently leave the tpm budget
        // over-available for whoever takes from it next. GIVE_SCRIPT's
        // avail = min(cap, avail + amount) handles a negative amount
        // (a charge) the same way it handles a positive one (a refund).
        const diff = estimatedTokens - actualTokens;
        if (diff !== 0) void give(tokens, diff);
      }

      if (success) void resize('grow');
    };
  }

  return {
    estimate(request) {
      return estimateTokensFn(request);
    },

    async acquire(estimatedTokens, signal): Promise<RateLimitAcquireResult> {
      if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
        throw new LLMError(
          `Rate limit acquire called with an invalid estimatedTokens value: ${estimatedTokens}`,
          'invalid_params',
        );
      }

      // tokensPerMinute is a fixed cap, never grown by AIMD (only rpm
      // is), so a request estimated above it can never succeed no
      // matter how long it waits. Fail fast instead of retrying it
      // silently until maxQueueMs times out.
      if (
        options.tokensPerMinute !== undefined &&
        options.tokensPerMinute > 0 &&
        estimatedTokens > options.tokensPerMinute
      ) {
        throw new LLMError(
          `Estimated tokens (${estimatedTokens}) exceed the fixed tokensPerMinute capacity (${options.tokensPerMinute}); this request can never be satisfied`,
          'rate_limited',
          { code: 'rate_limit_capacity_exceeded' },
        );
      }

      const startedAt = Date.now();
      let lastReason: Bucket['reason'] | undefined;

      while (true) {
        if (signal?.aborted) {
          throw new LLMError('Rate limit wait aborted', 'aborted');
        }

        const attempt = await tryTakeAll(estimatedTokens);
        if (attempt.ok) {
          return {
            release: makeRelease(estimatedTokens),
            waitedMs: Date.now() - startedAt,
            reason: lastReason,
          };
        }

        lastReason = attempt.bucket.reason;

        const elapsed = Date.now() - startedAt;
        if (maxQueueMs > 0 && elapsed >= maxQueueMs) {
          throw new LLMError(
            'Rate limit queue timed out before capacity was available',
            'rate_limited',
            {
              code: 'rate_limit_queue_timeout',
            },
          );
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
            Math.max(1, remainingBudget),
          );
          await sleepOrAbort(delay, signal);
        } else if (options.subscriber) {
          // concurrency: only an external release clears this, wake on
          // that release's notification (or pollIntervalMs, whichever first).
          await waitForWakeOrPoll(waiterRegistry, attempt.bucket.key, pollIntervalMs, signal);
        } else {
          await sleepOrAbort(Math.min(pollIntervalMs, Math.max(1, remainingBudget)), signal);
        }
      }
    },

    signalRateLimit() {
      void resize('shrink');
    },

    reactToRateLimitHint(hint: ProviderRateLimitHint | undefined) {
      if (!aimd || !hint || hint.remainingRequests === undefined) return;

      const floor = aimd.proactiveFloor ?? 0;
      if (floor > 0 && hint.remainingRequests <= floor) {
        void resize('shrink');
      }
    },

    // getState is intentionally omitted: RateLimiterAdapter requires it
    // to be synchronous, but reading current bucket levels means a
    // Redis round trip. Callers needing live state should read the
    // relevant Redis keys directly instead.
  };
}
