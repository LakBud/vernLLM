import type { RedisClient, RedisSubscriber } from '../types.js';

/** The node-redis (v4+) shape this package calls. */
export interface NodeRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  del(keys: string[]): Promise<unknown>;
  eval(script: string, options: { keys?: string[]; arguments?: string[] }): Promise<unknown>;
  /** Optional, as RedisClient.evalsha. */
  evalSha?(sha: string, options: { keys?: string[]; arguments?: string[] }): Promise<unknown>;
  /** Optional, as RedisClient.scan. */
  scan?(
    cursor: number,
    options: { MATCH: string; COUNT: number },
  ): Promise<{ cursor: number; keys: string[] }>;
}

/** Adapts a connected node-redis client to RedisClient. */
export function fromNodeRedis(client: NodeRedisLike): RedisClient {
  const split = (numKeys: number, args: (string | number)[]) => ({
    keys: args.slice(0, numKeys).map(String),
    arguments: args.slice(numKeys).map(String),
  });

  const base: RedisClient = {
    get: (key: string) => client.get(key),
    set: (key: string, value: string, _mode: 'PX', durationMs: number) =>
      client.set(key, value, { PX: durationMs }),
    del: (...keys: string[]) => client.del(keys),
    eval: (script: string, numKeys: number, ...args: (string | number)[]) =>
      client.eval(script, split(numKeys, args)),
  };

  if (client.evalSha) {
    base.evalsha = (sha, numKeys, ...args) => client.evalSha!(sha, split(numKeys, args));
  }

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
  unsubscribe?(channel: string): Promise<unknown>;
}

/** Adapts a connected, duplicated node-redis client to RedisSubscriber. */
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
        // Marked only on success, so a failed subscribe can be retried.
        subscribed.add(channel);
      } catch (error) {
        subscribed.delete(channel);
        throw error;
      }
    },
    async unsubscribe(channel) {
      if (!subscribed.has(channel)) return;
      subscribed.delete(channel);
      // Listeners stay: another adapter may still use this subscriber.
      await client.unsubscribe?.(channel);
    },
    on(event, listener) {
      if (event === 'message') listeners.push(listener);
      return this;
    },
    off(event, listener) {
      const index = event === 'message' ? listeners.indexOf(listener) : -1;
      if (index !== -1) listeners.splice(index, 1);
      return this;
    },
  };
}
