import type { RedisClient, RedisSubscriber } from '../types.js';

/**
 * The minimal ioredis shape this package actually calls. A real ioredis
 * `Redis` (or `Redis.Cluster`) instance satisfies this structurally, no
 * import from 'ioredis' required here. An alias of `RedisClient` so the
 * two can never drift apart.
 */
export type IoredisLike = RedisClient;

/** ioredis already matches RedisClient's shape exactly. This exists for symmetry with fromNodeRedis, so an ioredis API change has one place to absorb it. */
export function fromIoredis(client: IoredisLike): RedisClient {
  return client;
}

/** The subscriber half, an alias of `RedisSubscriber` for the same reason. */
export type IoredisSubscriberLike = RedisSubscriber;

/**
 * ioredis's own subscribe/'message' shape already matches RedisSubscriber
 * exactly. Pass a duplicated connection (`client.duplicate()`), never the
 * same connection used for regular commands, subscribe mode blocks
 * everything else on that connection.
 */
export function fromIoredisSubscriber(client: IoredisSubscriberLike): RedisSubscriber {
  return client;
}
