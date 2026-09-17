import type { RedisClient, RedisSubscriber } from '../types.js';

/** The minimal node-redis (the "redis" package, v4+) shape this package actually calls. */
export interface NodeRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  del(keys: string[]): Promise<unknown>;
  eval(script: string, options: { keys?: string[]; arguments?: string[] }): Promise<unknown>;
  /** node-redis's own scan shape. Optional, same reasoning as RedisClient.scan. */
  scan?(
    cursor: number,
    options: { MATCH: string; COUNT: number },
  ): Promise<{ cursor: number; keys: string[] }>;
}

/**
 * Translates node-redis's option-object call shapes (set's { PX }, eval's
 * { keys, arguments }, scan's numeric cursor and { MATCH, COUNT }) onto
 * RedisClient's ioredis-shaped, positional one. Pass an already-connected
 * node-redis client.
 */
export function fromNodeRedis(client: NodeRedisLike): RedisClient {
  const base = {
    get: (key: string) => client.get(key),
    set: (key: string, value: string, _mode: 'PX', durationMs: number) =>
      client.set(key, value, { PX: durationMs }),
    del: (...keys: string[]) => client.del(keys),
    eval: (script: string, numKeys: number, ...args: (string | number)[]) => {
      const keys = args.slice(0, numKeys).map(String);
      const argv = args.slice(numKeys).map(String);
      return client.eval(script, { keys, arguments: argv });
    },
  };

  if (!client.scan) return base;

  return {
    ...base,
    scan: async (cursor: string, _match: 'MATCH', pattern: string, _count: 'COUNT', count) => {
      const result = await client.scan!(Number(cursor), { MATCH: pattern, COUNT: count });
      return [String(result.cursor), result.keys];
    },
  };
}

export interface NodeRedisSubscriberLike {
  subscribe(
    channel: string,
    listener: (message: string, channel: string) => void,
  ): Promise<unknown>;
}

/**
 * node-redis has no generic 'message' event, subscribe() instead takes a
 * per-channel callback. This shims that into RedisSubscriber's
 * subscribe + on('message') shape, so the rest of this package never
 * needs to know which client it's talking to.
 *
 * Pass an already-connected, duplicated client (`client.duplicate()`,
 * then `await connect()`), never the same connection used for regular
 * commands.
 */
export function fromNodeRedisSubscriber(client: NodeRedisSubscriberLike): RedisSubscriber {
  const listeners: Array<(channel: string, message: string) => void> = [];
  const subscribed = new Set<string>();

  return {
    async subscribe(channel) {
      if (subscribed.has(channel)) return;

      try {
        await client.subscribe(channel, (message, ch) => {
          for (const listener of listeners) listener(ch, message);
        });
        // Only marked subscribed once the subscription has actually
        // succeeded, so a failed attempt can be retried instead of
        // being silently treated as already subscribed forever.
        subscribed.add(channel);
      } catch (error) {
        subscribed.delete(channel);
        throw error;
      }
    },
    on(event, listener) {
      if (event === 'message') listeners.push(listener);
      return this;
    },
  };
}
