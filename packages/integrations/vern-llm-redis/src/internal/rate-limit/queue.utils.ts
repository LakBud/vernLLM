import { QUEUE_SCRIPT, parseQueueResult } from './scripts.js';

import type { RedisClient } from '../../types.js';

export type QueueOp = (
  op: 'peek' | 'enter' | 'check' | 'leave',
  id: string,
) => Promise<{ isHead: boolean; depth: number; full: boolean }>;

/** One op against the shared line. */
export function createQueueOp(deps: {
  redis: RedisClient;
  queueKey: string;
  queueLeaseMs: number;
  wakeChannel: string;
  maxQueueSize: number;
}): QueueOp {
  const { redis, queueKey, queueLeaseMs, wakeChannel, maxQueueSize } = deps;

  return async (op, id) =>
    parseQueueResult(
      await redis.eval(QUEUE_SCRIPT, 1, queueKey, op, id, queueLeaseMs, wakeChannel, maxQueueSize),
    );
}
