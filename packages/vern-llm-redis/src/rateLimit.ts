import { type RateLimiterAdapter, type RateLimitState, type WireRequest } from 'vern-llm';

import { createAcquirer } from './internal/rate-limit/acquire.js';
import { type AimdOptions } from './internal/rate-limit/aimd.utils.js';
import { createBucketOps } from './internal/rate-limit/bucketOps.js';
import { buildBuckets } from './internal/rate-limit/buckets.utils.js';
import { createQueueOp } from './internal/rate-limit/queue.utils.js';
import { resolveRateLimitOptions } from './internal/rate-limit/rateLimitOptions.utils.js';
import { createReleaseFactory, createResizer } from './internal/rate-limit/release.utils.js';
import { createSnapshots, setStateField } from './internal/rate-limit/snapshots.utils.js';
import { createWaiterRegistry } from './internal/rate-limit/waiterRegistry.utils.js';
import { toRedisError } from './internal/shared/errors/redisError.utils.js';
import { createAdapterLogger, type AdapterLoggerOption } from './internal/shared/logger.utils.js';
import { withScriptCache } from './internal/shared/redis/scriptCache.utils.js';
import { attachSubscriber } from './internal/shared/redis/subscriber.utils.js';
import { createHeartbeats, renewalInterval } from './internal/shared/timing/heartbeat.utils.js';

import type { RedisClient, RedisSubscriber } from './types.js';

export type { AimdOptions };

/** vern-llm's hint type, not exported from its entry point. Only `remainingRequests` is read. */
interface ProviderRateLimitHint {
  remainingRequests?: number;
}

export interface RedisRateLimitOptions {
  /** Max requests per minute, `0` or at least 1. Also the AIMD ceiling's start. */
  requestsPerMinute?: number;
  /** Max tokens per minute, `0` or at least 1, checked against the estimate. */
  tokensPerMinute?: number;
  /** Max requests in flight across every process. */
  maxConcurrent?: number;
  /** Max wait for capacity in ms. Default 30000, `0` waits indefinitely. */
  maxQueueMs?: number;
  /** Max waiters across every process before `rate_limit_queue_full`. Default 0, unbounded. */
  maxQueueSize?: number;
  /** Scales the token estimate down, in (0, 1]. Default 1. */
  estimateFraction?: number;
  /** First come first served across processes. Default true. */
  fairQueue?: boolean;
  /** How long a waiter's place survives unrenewed, in ms. Default 15000. */
  queueLeaseMs?: number;
  /** Where background failures go. Defaults to the VernLLM logger. `'silent'` discards them. */
  logger?: AdapterLoggerOption;
  /** How long a concurrency slot survives unrenewed, in ms. Default 30000. */
  concurrencyLeaseMs?: number;
  /** Poll interval for a concurrency wait without a subscriber, in ms. Default 250. */
  pollIntervalMs?: number;
  estimateTokens?: (request: WireRequest) => number;
  /** Prefix for every key. Default "vernllm:rl". */
  keyPrefix?: string;
  /** AIMD on the requests per minute ceiling, shared by every process. Requires `requestsPerMinute`. */
  aimd?: AimdOptions;
  /** A dedicated pub/sub connection, so a concurrency wait wakes on release instead of polling. */
  subscriber?: RedisSubscriber;
}

/** A `RateLimiterAdapter` with the extras `redisRateLimit` adds. */
export interface RedisRateLimiterAdapter extends RateLimiterAdapter {
  /** Live bucket levels from Redis. `getState()` only has what this process last saw. */
  readState(): Promise<RateLimitState>;
  /** Stops renewals and detaches the subscriber. Call before closing the client. Idempotent. */
  dispose(): void;
}

/** A RateLimiterAdapter backed by Redis, shared by every process using the same keys. */
export function redisRateLimit(
  client: RedisClient,
  options: RedisRateLimitOptions = {},
): RedisRateLimiterAdapter {
  const redis = withScriptCache(client);
  const config = resolveRateLimitOptions(options);
  const { keyPrefix, wakeChannel, queueKey, concurrencyLeaseMs, queueLeaseMs, aimd } = config;
  const log = createAdapterLogger('redisRateLimit', options.logger);

  const { buckets, rpmBucket } = buildBuckets({
    keyPrefix,
    maxConcurrent: options.maxConcurrent,
    requestsPerMinute: options.requestsPerMinute,
    tokensPerMinute: options.tokensPerMinute,
    aimd,
  });

  let disposed = false;

  const waiterRegistry = createWaiterRegistry();

  const detachSubscriber = options.subscriber
    ? attachSubscriber(options.subscriber, wakeChannel, {
        isDisposed: () => disposed,
        onMessage: (message) => waiterRegistry.wake(message),
        onSubscribeError: (error) => log.failure('subscribe', error, wakeChannel),
      })
    : undefined;

  const heartbeats = createHeartbeats();
  const snapshots = createSnapshots(buckets);
  const ops = createBucketOps({ redis, buckets, concurrencyLeaseMs, wakeChannel, snapshots, log });
  const resize = createResizer({ redis, aimd, rpmBucket, log });

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
    queueOp: createQueueOp({
      redis,
      queueKey,
      queueLeaseMs,
      wakeChannel,
      maxQueueSize: config.maxQueueSize,
    }),
    tryTakeAll: ops.tryTakeAll,
    startHeartbeat: (bucket, leaseId) =>
      heartbeats.start(() => {
        ops
          .renewLease(bucket, leaseId)
          .catch((error: unknown) => log.failure('lease renewal', error));
      }, renewalInterval(concurrencyLeaseMs)),
    makeRelease: createReleaseFactory({ buckets, ops, snapshots, resize, log }),
    reportRejection: (operation, error) => log.failure(operation, error),
  });

  return {
    estimate(request) {
      return Math.ceil(config.estimateTokens(request) * config.estimateFraction);
    },

    acquire,

    signalRateLimit() {
      resize('shrink');
    },

    reactToRateLimitHint(hint: ProviderRateLimitHint | undefined) {
      if (!aimd || !hint || hint.remainingRequests === undefined) return;

      const floor = aimd.proactiveFloor ?? 0;
      if (floor > 0 && hint.remainingRequests <= floor) resize('shrink');
    },

    /** What this process last saw, refilled forward to now. */
    getState() {
      return snapshots.view();
    },

    setLogger(logger) {
      log.adopt(logger);
    },

    async readState() {
      const state: RateLimitState = {};

      for (const bucket of buckets) {
        const { avail, cap } = await ops.read(bucket).catch((error: unknown) => {
          throw toRedisError('readState', error);
        });
        snapshots.observe(bucket, avail, cap);
        setStateField(state, bucket, avail, cap);
      }

      return state;
    },

    dispose() {
      disposed = true;
      log.mute();
      heartbeats.stopAll();
      detachSubscriber?.();
    },
  };
}
