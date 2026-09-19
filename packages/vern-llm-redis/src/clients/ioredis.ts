import type { RedisClient, RedisSubscriber } from '../types.js';

/**
 * The minimal ioredis shape this package actually calls. A real ioredis
 * `Redis` (or `Redis.Cluster`) instance satisfies this structurally, no
 * import from 'ioredis' required here.
 */
export interface IoredisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', durationMs: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  scan?(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
}

/** ioredis already matches RedisClient's shape exactly. This exists for symmetry with fromNodeRedis, so an ioredis API change has one place to absorb it. */
export function fromIoredis(client: IoredisLike): RedisClient {
  return client;
}

export interface IoredisSubscriberLike {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe?(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
}

/**
 * ioredis's own subscribe/'message' shape already matches RedisSubscriber
 * exactly. Pass a duplicated connection (`client.duplicate()`), never the
 * same connection used for regular commands, subscribe mode blocks
 * everything else on that connection.
 */
export function fromIoredisSubscriber(client: IoredisSubscriberLike): RedisSubscriber {
  return client;
}
