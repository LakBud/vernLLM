import { amountFor, keysFor, type Bucket } from './buckets.utils.js';
import {
  GIVE_LEASE_SCRIPT,
  GIVE_SCRIPT,
  RENEW_LEASE_SCRIPT,
  STATE_SCRIPT,
  TAKE_LEASE_SCRIPT,
  TAKE_SCRIPT,
  parseStateResult,
  parseTakeResult,
} from './scripts.js';

import type { RedisClient } from '../../types.js';
import type { AdapterLogger } from '../shared/logger.utils.js';
import type { TakeAttempt } from './acquire.js';
import type { Snapshots } from './snapshots.utils.js';

/** Every Redis round trip the limiter makes against its buckets. */
export interface BucketOps {
  /** Gives back to a per minute bucket. A negative amount charges it. */
  give(bucket: Bucket, amount: number): Promise<void>;
  /** Ends a concurrency lease and wakes waiters. */
  giveLease(bucket: Bucket, leaseId: string): Promise<void>;
  renewLease(bucket: Bucket, leaseId: string): Promise<void>;
  /** Takes one call's share from every bucket, or none of them. */
  tryTakeAll(estimatedTokens: number, leaseId: string): Promise<TakeAttempt>;
  /** Reads one bucket without writing. */
  read(bucket: Bucket): Promise<{ avail: number; cap: number }>;
}

export function createBucketOps(deps: {
  redis: RedisClient;
  buckets: Bucket[];
  concurrencyLeaseMs: number;
  wakeChannel: string;
  snapshots: Snapshots;
  log: AdapterLogger;
}): BucketOps {
  const { redis, buckets, concurrencyLeaseMs, wakeChannel, snapshots, log } = deps;

  async function give(bucket: Bucket, amount: number): Promise<void> {
    const keys = keysFor(bucket);
    await redis.eval(GIVE_SCRIPT, keys.length, ...keys, bucket.initialCapacity, amount);
  }

  async function giveLease(bucket: Bucket, leaseId: string): Promise<void> {
    await redis.eval(GIVE_LEASE_SCRIPT, 1, bucket.key, leaseId, wakeChannel);
  }

  /** Best effort undo: a failure never masks the miss behind it. */
  async function undo(bucket: Bucket, estimatedTokens: number, leaseId: string): Promise<void> {
    try {
      if (bucket.rateMode === 'lease') await giveLease(bucket, leaseId);
      else await give(bucket, amountFor(bucket, estimatedTokens));
    } catch (error) {
      log.failure('rollback', error);
    }
  }

  async function undoAll(taken: Bucket[], estimatedTokens: number, leaseId: string): Promise<void> {
    for (const entry of taken) await undo(entry, estimatedTokens, leaseId);
  }

  /** Takes from one bucket and records the reply. */
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
            keysFor(bucket).length,
            ...keysFor(bucket),
            bucket.initialCapacity,
            amountFor(bucket, estimatedTokens),
          );

    const result = parseTakeResult(await raw);
    snapshots.observe(bucket, result.avail, result.cap);
    return result;
  }

  return {
    give,
    giveLease,

    async renewLease(bucket, leaseId) {
      await redis.eval(RENEW_LEASE_SCRIPT, 1, bucket.key, leaseId, concurrencyLeaseMs);
    },

    async tryTakeAll(estimatedTokens, leaseId) {
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
        // Undo what was taken, or it stays held by no call.
        await undoAll(taken, estimatedTokens, leaseId);
        throw error;
      }

      if (missed) {
        await undoAll(taken, estimatedTokens, leaseId);
        return { ok: false, ...missed };
      }

      return { ok: true };
    },

    async read(bucket) {
      const keys = keysFor(bucket);
      return parseStateResult(
        await redis.eval(
          STATE_SCRIPT,
          keys.length,
          ...keys,
          bucket.rateMode,
          bucket.initialCapacity,
        ),
      );
    },
  };
}
