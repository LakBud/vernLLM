import { AIMD_SHRINK_WINDOW_MS, type AimdOptions } from './aimd.utils.js';
import { RESIZE_SCRIPT } from './scripts.js';

import type { RedisClient } from '../../types.js';
import type { AdapterLogger } from '../shared/logger.utils.js';
import type { BucketOps } from './bucketOps.js';
import type { Bucket } from './buckets.utils.js';
import type { Snapshots } from './snapshots.utils.js';

export type ResizeOp = 'grow' | 'shrink';

/** Resizes the AIMD ceiling in the background, logging failures. A no op without AIMD. */
export function createResizer(deps: {
  redis: RedisClient;
  aimd: AimdOptions | undefined;
  rpmBucket: Bucket | undefined;
  log: AdapterLogger;
}): (op: ResizeOp) => void {
  const { redis, aimd, rpmBucket, log } = deps;

  async function resize(op: ResizeOp): Promise<void> {
    if (!aimd || !rpmBucket) return;

    await redis.eval(
      RESIZE_SCRIPT,
      2,
      rpmBucket.key,
      rpmBucket.capKey!,
      op,
      op === 'grow' ? aimd.increaseBy : aimd.decreaseFactor,
      aimd.minCapacity,
      aimd.maxCapacity,
      rpmBucket.initialCapacity,
      AIMD_SHRINK_WINDOW_MS,
    );
  }

  return (op) => {
    resize(op).catch((error: unknown) => log.failure(`AIMD ${op}`, error));
  };
}

export type Release = (actualTokens?: number, success?: boolean) => void;

/** One call's release, run once: frees its slot, settles tokens, grows AIMD on success. */
export function createReleaseFactory(deps: {
  buckets: Bucket[];
  ops: BucketOps;
  snapshots: Snapshots;
  resize: (op: ResizeOp) => void;
  log: AdapterLogger;
}): (estimatedTokens: number, leaseId: string, stopHeartbeat: (() => void) | undefined) => Release {
  const { buckets, ops, snapshots, resize, log } = deps;
  const concurrency = buckets.find((b) => b.reason === 'concurrency');
  const tokens = buckets.find((b) => b.reason === 'tpm');

  return (estimatedTokens, leaseId, stopHeartbeat) => {
    let released = false;

    return (actualTokens, success = false) => {
      if (released) return;
      released = true;

      stopHeartbeat?.();

      if (concurrency) {
        snapshots.adjust(concurrency, 1);
        ops
          .giveLease(concurrency, leaseId)
          .catch((error: unknown) => log.failure('concurrency release', error));
      }

      if (
        tokens &&
        actualTokens !== undefined &&
        Number.isFinite(actualTokens) &&
        actualTokens >= 0
      ) {
        // Positive refunds, negative charges what the estimate missed.
        const diff = estimatedTokens - actualTokens;
        if (diff !== 0) {
          snapshots.adjust(tokens, diff);
          ops.give(tokens, diff).catch((error: unknown) => log.failure('token refund', error));
        }
      }

      if (success) resize('grow');
    };
  };
}
