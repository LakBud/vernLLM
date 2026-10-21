import { describe, expect, it } from 'vitest';

import { QUEUE_SCRIPT } from '../../../src/internal/rate-limit/scripts.js';
import { redisRateLimit } from '../../../src/rateLimit.js';
import { fakeRedisClient } from '../../helpers.js';

describe('redisRateLimit fair queue, nobody ahead but no capacity', () => {
  it('joins the line after a miss, looks again instead of sleeping, then takes capacity as head', async () => {
    const redis = fakeRedisClient();
    const queueOps: string[] = [];
    let takes = 0;

    redis.eval.mockImplementation(
      async (script: string, _numKeys: number, _key: string, op: string) => {
        if (script === QUEUE_SCRIPT) {
          queueOps.push(op);
          if (op === 'peek') return [0, 0]; // empty line, so no one to queue behind
          if (op === 'enter') return [0, 1];
          if (op === 'check') return [1, 1]; // now the head
          return [0, 0]; // leave
        }

        takes += 1;
        return takes === 1 ? [0, '0', '1', '-1'] : [1, '0', '1', '-1'];
      },
    );

    const limiter = redisRateLimit(redis, { maxConcurrent: 1 });
    const held = await limiter.acquire(1);

    expect(queueOps).toEqual(['peek', 'enter', 'check', 'leave']);
    expect(takes).toBe(2);
    expect(held.reason).toBe('concurrency');

    held.release();
    limiter.dispose();
  });
});
