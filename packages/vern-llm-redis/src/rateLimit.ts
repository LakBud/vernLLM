import { type RateLimiterAdapter, type RateLimitState, type WireRequest } from 'vern-llm';

import { createAdapterLogger, type AdapterLoggerOption } from './internal/logger.utils.js';
import { createAcquirer, type TakeAttempt } from './internal/rate-limit/acquire.js';
import { type AimdOptions } from './internal/rate-limit/aimd.utils.js';
import { amountFor, buildBuckets, type Bucket } from './internal/rate-limit/buckets.utils.js';
import { resolveRateLimitOptions } from './internal/rate-limit/rateLimitOptions.utils.js';
import {
  GIVE_LEASE_SCRIPT,
  GIVE_SCRIPT,
  QUEUE_SCRIPT,
  RENEW_LEASE_SCRIPT,
  RESIZE_SCRIPT,
  STATE_SCRIPT,
  TAKE_LEASE_SCRIPT,
  TAKE_SCRIPT,
  parseQueueResult,
  parseStateResult,
  parseTakeResult,
} from './internal/rate-limit/scripts.js';
import { createWaiterRegistry } from './internal/rate-limit/waiterRegistry.utils.js';
import { attachSubscriber } from './internal/subscriber.utils.js';
import { unrefTimer, type TimerHandle } from './internal/timers.utils.js';

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
  /** Max time a call may wait for capacity before throwing, in ms. Default 30000. Pass 0 to wait indefinitely. */
  maxQueueMs?: number;
  /**
   * Max calls this process may have waiting for capacity at once before
   * new ones reject immediately with `rate_limit_queue_full` instead of
   * waiting. Default 0, meaning unbounded. Counted per process: another
   * process's waiters are not visible here.
   */
  maxQueueSize?: number;
  /**
   * Scales the pre-flight token estimate down before it is reserved
   * against `tokensPerMinute`, since most calls don't use their full
   * `max_tokens`. `release`'s `actualTokens` still reconciles against real
   * usage. Default 1, no scaling. Must be a finite number greater than 0;
   * values above 1 are clamped to 1. Same as core's.
   */
  estimateFraction?: number;
  /**
   * Serve waiters strictly first come first served across every process
   * using this limiter, so a large or unlucky call is never starved by
   * others whose polls happen to land first. Default true. Set false to
   * skip the shared queue, which saves a few Redis calls per waiting call.
   */
  fairQueue?: boolean;
  /**
   * How long a waiter's place in the shared queue survives without being
   * renewed before Redis treats it as gone, in ms. A live waiter renews
   * it on every check, so this only decides how fast a crashed waiter
   * stops blocking the line. Default 15000.
   */
  queueLeaseMs?: number;
  /**
   * Where this adapter reports background failures. Defaults to the
   * `logger` of the `VernLLM` instance the adapter is passed to, or the
   * console if it is used on its own. Pass `'silent'` to discard them.
   */
  logger?: AdapterLoggerOption;
  /**
   * How long a concurrency slot may go without being renewed before Redis
   * treats its holder as gone and frees it, in ms. A live call renews its
   * slot automatically about three times per lease, so this only decides
   * how fast a crashed process's slots come back, not how long a call may
   * run. Default 30000.
   */
  concurrencyLeaseMs?: number;
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

/** A `RateLimiterAdapter` with the extras `redisRateLimit` adds. */
export interface RedisRateLimiterAdapter extends RateLimiterAdapter {
  /** Live bucket levels read from Redis, shared across every process. `getState()` reports only what this process last saw. */
  readState(): Promise<RateLimitState>;
  /**
   * Stops every renewal timer and detaches from the subscriber. Call it
   * before closing the Redis client (shutdown, hot reload, tests).
   * Idempotent. Slots still held simply lapse after `concurrencyLeaseMs`.
   */
  dispose(): void;
}

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
): RedisRateLimiterAdapter {
  const config = resolveRateLimitOptions(options);
  const { keyPrefix, wakeChannel, queueKey, concurrencyLeaseMs, queueLeaseMs, aimd } = config;
  const log = createAdapterLogger('redisRateLimit', options.logger);

  const { buckets, rpmBucket } = buildBuckets({
    keyPrefix,
    maxConcurrent: options.maxConcurrent,
    requestsPerMinute: options.requestsPerMinute,
    tokensPerMinute: options.tokensPerMinute,
  });

  let disposed = false;

  // Waiters blocked on a specific key's concurrency bucket, woken by
  // GIVE_LEASE_SCRIPT's PUBLISH the moment a slot frees, instead of polling.
  const waiterRegistry = createWaiterRegistry();

  const detachSubscriber = options.subscriber
    ? attachSubscriber(options.subscriber, wakeChannel, {
        isDisposed: () => disposed,
        onMessage: (message) => waiterRegistry.wake(message),
        onSubscribeError: (error) => log.failure('subscribe', error, wakeChannel),
      })
    : undefined;

  // Every fire-and-forget Redis call below (a release, a resize, a lease
  // renewal) is reported through `log.failure` instead of becoming an
  // unhandled rejection that would take the whole process down after the
  // call it belongs to already succeeded. Silent after dispose(): a
  // closing client failing is expected then.

  /** Renewal timers for every concurrency lease this process currently holds, so dispose() can stop them all. */
  const heartbeats = new Set<TimerHandle>();

  /**
   * Keeps one lease alive for as long as its call runs, so a long stream
   * never loses its slot while a crashed process's slot still lapses
   * within `concurrencyLeaseMs`. Returns a function that stops it.
   */
  function startHeartbeat(bucket: Bucket, leaseId: string): () => void {
    const timer = setInterval(
      () => {
        redis
          .eval(RENEW_LEASE_SCRIPT, 1, bucket.key, leaseId, concurrencyLeaseMs)
          .catch((error: unknown) => log.failure('lease renewal', error));
      },
      Math.max(1, Math.floor(concurrencyLeaseMs / 3)),
    );
    unrefTimer(timer);
    heartbeats.add(timer);

    return () => {
      clearInterval(timer);
      heartbeats.delete(timer);
    };
  }

  /**
   * What this process last saw of each bucket, straight from Redis's own
   * replies to its takes and reads, stamped with a local monotonic offset.
   * It is all the synchronous `getState` has to go on.
   */
  const snapshots = new Map<string, { avail: number; cap: number; at: number }>(
    // Seeded as untouched, so every bucket always has a snapshot and a
    // process that has not made a call yet reports full capacity.
    buckets.map((bucket) => [
      bucket.key,
      { avail: bucket.initialCapacity, cap: bucket.initialCapacity, at: performance.now() },
    ]),
  );

  function observe(bucket: Bucket, avail: number, cap: number): void {
    snapshots.set(bucket.key, { avail, cap, at: performance.now() });
  }

  /** Applies a change this process itself just made, so getState reflects it before the next take. */
  function adjust(bucket: Bucket, delta: number): void {
    const snap = snapshots.get(bucket.key)!;
    snap.avail = Math.min(snap.cap, snap.avail + delta);
  }

  /** Gives requests or tokens back to a per minute bucket. */
  async function give(bucket: Bucket, amount: number): Promise<void> {
    await redis.eval(GIVE_SCRIPT, 1, bucket.key, bucket.initialCapacity, amount);
  }

  /** Ends a concurrency lease and wakes waiters. */
  async function giveLease(bucket: Bucket, leaseId: string): Promise<void> {
    await redis.eval(GIVE_LEASE_SCRIPT, 1, bucket.key, leaseId, wakeChannel);
  }

  /** Undoes one bucket's take. Best effort: a failure here must never mask the error or miss that led to it. */
  async function undo(bucket: Bucket, estimatedTokens: number, leaseId: string): Promise<void> {
    try {
      if (bucket.rateMode === 'lease') await giveLease(bucket, leaseId);
      else await give(bucket, amountFor(bucket, estimatedTokens));
    } catch (error) {
      log.failure('rollback', error);
    }
  }

  /** Undoes every bucket taken so far, when a later one in the chain missed or failed. */
  async function undoAll(taken: Bucket[], estimatedTokens: number, leaseId: string): Promise<void> {
    for (const entry of taken) await undo(entry, estimatedTokens, leaseId);
  }

  /** Takes one call's share from one bucket and records what Redis reported. */
  async function takeFrom(bucket: Bucket, estimatedTokens: number, leaseId: string) {
    const raw =
      bucket.rateMode === 'lease'
        ? redis.eval(
            TAKE_LEASE_SCRIPT,
            1,
            bucket.key,
            bucket.initialCapacity,
            leaseId,
            concurrencyLeaseMs,
          )
        : redis.eval(
            TAKE_SCRIPT,
            1,
            bucket.key,
            bucket.initialCapacity,
            amountFor(bucket, estimatedTokens),
          );

    const result = parseTakeResult(await raw);
    observe(bucket, result.avail, result.cap);
    return result;
  }

  async function tryTakeAll(estimatedTokens: number, leaseId: string): Promise<TakeAttempt> {
    const taken: Bucket[] = [];
    let missed: { bucket: Bucket; waitMs: number } | undefined;

    try {
      for (const bucket of buckets) {
        const result = await takeFrom(bucket, estimatedTokens, leaseId);

        if (!result.ok) {
          missed = { bucket, waitMs: result.waitMs };
          break;
        }

        taken.push(bucket);
      }
    } catch (error) {
      // A Redis error between two bucket takes would otherwise leave the
      // earlier ones taken with nobody holding the call that took them.
      await undoAll(taken, estimatedTokens, leaseId);
      throw error;
    }

    if (missed) {
      await undoAll(taken, estimatedTokens, leaseId);
      return { ok: false, ...missed };
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

  function resizeQuietly(op: 'grow' | 'shrink'): void {
    resize(op).catch((error: unknown) => log.failure(`AIMD ${op}`, error));
  }

  function makeRelease(
    estimatedTokens: number,
    leaseId: string,
    stopHeartbeat: (() => void) | undefined,
  ): (actualTokens?: number, success?: boolean) => void {
    let released = false;

    return (actualTokens?: number, success = false) => {
      if (released) return;
      released = true;

      stopHeartbeat?.();

      const concurrency = buckets.find((b) => b.reason === 'concurrency');
      if (concurrency) {
        adjust(concurrency, 1);
        giveLease(concurrency, leaseId).catch((error: unknown) =>
          log.failure('concurrency release', error),
        );
      }

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
        if (diff !== 0) {
          adjust(tokens, diff);
          give(tokens, diff).catch((error: unknown) => log.failure('token refund', error));
        }
      }

      if (success) resizeQuietly('grow');
    };
  }

  /** One op against the shared FIFO line, `id` being this call's own lease id. */
  async function queueOp(
    op: 'peek' | 'enter' | 'check' | 'leave',
    id: string,
  ): Promise<{ isHead: boolean; depth: number }> {
    return parseQueueResult(
      await redis.eval(QUEUE_SCRIPT, 1, queueKey, op, id, queueLeaseMs, wakeChannel),
    );
  }

  const acquire = createAcquirer({
    buckets,
    tokensPerMinute: options.tokensPerMinute,
    maxQueueMs: config.maxQueueMs,
    maxQueueSize: config.maxQueueSize,
    pollIntervalMs: config.pollIntervalMs,
    queueLeaseMs,
    fairQueue: config.fairQueue,
    hasSubscriber: options.subscriber !== undefined,
    subscriptionReady: detachSubscriber?.ready,
    queueKey,
    waiterRegistry,
    queueOp,
    tryTakeAll,
    startHeartbeat,
    makeRelease,
    reportRejection: (operation, error) => log.failure(operation, error),
  });

  return {
    estimate(request) {
      return Math.ceil(config.estimateTokens(request) * config.estimateFraction);
    },

    acquire,

    signalRateLimit() {
      resizeQuietly('shrink');
    },

    reactToRateLimitHint(hint: ProviderRateLimitHint | undefined) {
      if (!aimd || !hint || hint.remainingRequests === undefined) return;

      const floor = aimd.proactiveFloor ?? 0;
      if (floor > 0 && hint.remainingRequests <= floor) {
        resizeQuietly('shrink');
      }
    },

    /**
     * Synchronous, so it can't ask Redis: it reports what this process
     * last saw, with the per minute buckets refilled forward by the time
     * that has passed since. Other processes' activity since is invisible
     * here, `readState()` is the live read. Before this process has made a
     * call it reports each bucket as untouched.
     */
    getState() {
      const state: RateLimitState = {};
      const now = performance.now();

      for (const bucket of buckets) {
        const snap = snapshots.get(bucket.key)!;
        const cap = snap.cap;
        let avail = snap.avail;

        if (bucket.rateMode === 'permin') {
          avail = Math.min(cap, avail + ((now - snap.at) * cap) / 60_000);
        }

        if (bucket.reason === 'rpm') state.requestsRemaining = avail;
        else if (bucket.reason === 'tpm') state.tokensRemaining = avail;
        else state.concurrentInFlight = Math.max(0, cap - avail);
      }

      return state;
    },

    setLogger(logger) {
      log.adopt(logger);
    },

    async readState() {
      const state: RateLimitState = {};

      for (const bucket of buckets) {
        const { avail, cap } = parseStateResult(
          await redis.eval(STATE_SCRIPT, 1, bucket.key, bucket.rateMode, bucket.initialCapacity),
        );
        observe(bucket, avail, cap);

        if (bucket.reason === 'rpm') state.requestsRemaining = avail;
        else if (bucket.reason === 'tpm') state.tokensRemaining = avail;
        else state.concurrentInFlight = cap - avail;
      }

      return state;
    },

    dispose() {
      disposed = true;
      log.mute();

      for (const timer of heartbeats) clearInterval(timer);
      heartbeats.clear();

      detachSubscriber?.();
    },
  };
}
