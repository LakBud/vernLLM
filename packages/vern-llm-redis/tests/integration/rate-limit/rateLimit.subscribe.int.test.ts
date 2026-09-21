import { expect } from 'vitest';

import { fromIoredisSubscriber } from '../../../src/clients/ioredis.js';
import { it } from '../../fixtures.js';
import { uniquePrefix, waitForRedisValue } from '../../helpers.js';

it('a release right after a slow SUBSCRIBE still wakes the waiter promptly', async ({
  redis,
  makeLimiter,
  newConnection,
}) => {
  const prefix = uniquePrefix('rl');
  const shared = { keyPrefix: prefix, maxConcurrent: 1, pollIntervalMs: 5000, maxQueueMs: 8000 };
  const held = await makeLimiter(shared, newConnection()).acquire(1);

  const real = newConnection();
  const slow = fromIoredisSubscriber(real);
  const origSubscribe = real.subscribe.bind(real) as (...a: unknown[]) => Promise<unknown>;
  (real as unknown as { subscribe: unknown }).subscribe = async (...a: unknown[]) => {
    await new Promise((r) => setTimeout(r, 400)); // slow subscribe under load
    return origSubscribe(...a);
  };

  const waiter = makeLimiter({ ...shared, subscriber: slow }, newConnection());
  let acquiredAt = 0;
  const waiting = waiter.acquire(1).then(() => (acquiredAt = Date.now()));
  await waitForRedisValue(
    () => redis.hlen(`${prefix}:queue`),
    (n) => n > 0,
    { timeoutMs: 1000, intervalMs: 10 },
  );

  const releasedAt = Date.now();
  held.release();
  await waiting;
  expect(acquiredAt - releasedAt).toBeLessThan(1500);
});
