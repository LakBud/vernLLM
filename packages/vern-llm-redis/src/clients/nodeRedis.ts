import type { RedisClient, RedisSubscriber } from '../types.js';

/** The minimal node-redis (the "redis" package, v4+) shape this package actually calls. */
export interface NodeRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  del(keys: string[]): Promise<unknown>;
  eval(script: string, options: { keys?: string[]; arguments?: string[] }): Promise<unknown>;
}

/**
 * Translates node-redis's option-object call shapes (set's { PX }, eval's
 * { keys, arguments }) onto RedisClient's ioredis-shaped, positional one.
 * Pass an already-connected node-redis client.
 */
export function fromNodeRedis(client: NodeRedisLike): RedisClient {
  return {
    get: (key) => client.get(key),
    set: (key, value, _mode, durationMs) => client.set(key, value, { PX: durationMs }),
    del: (...keys) => client.del(keys),
    eval: (script, numKeys, ...args) => {
      const keys = args.slice(0, numKeys).map(String);
      const argv = args.slice(numKeys).map(String);
      return client.eval(script, { keys, arguments: argv });
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
