/**
 * The subset of a Redis client every adapter in this package needs.
 * Matches ioredis's method shapes directly, so passing a real `Redis`
 * instance just works. Other clients (node-redis, Upstash) can be used
 * by wrapping them in an object with this same shape.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', durationMs: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * A second, dedicated connection used only for pub/sub. Redis clients in
 * subscribe mode cannot run other commands, so this must be a separate
 * connection from the one passed as RedisClient. ioredis's `duplicate()`
 * produces exactly this.
 */
export interface RedisSubscriber {
  subscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
}
