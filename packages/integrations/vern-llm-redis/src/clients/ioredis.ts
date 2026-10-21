import type { RedisClient, RedisSubscriber } from '../types.js';

/** The ioredis shape this package calls, an alias of RedisClient. */
export type IoredisLike = RedisClient;

/** ioredis already matches RedisClient. Kept for symmetry with fromNodeRedis. */
export function fromIoredis(client: IoredisLike): RedisClient {
  return client;
}

/** An alias of RedisSubscriber. */
export type IoredisSubscriberLike = RedisSubscriber;

/** ioredis already matches RedisSubscriber. Pass a duplicated connection. */
export function fromIoredisSubscriber(client: IoredisSubscriberLike): RedisSubscriber {
  return client;
}
