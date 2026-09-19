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
  /**
   * Cursor-paginated key scan, ioredis's own `scan(cursor, 'MATCH',
   * pattern, 'COUNT', count)` shape (tokens included, matching how
   * `set`'s `'PX'` mode is already kept above). Optional: only used to
   * seed a fresh circuit-breaker adapter's local cache with any circuit
   * already open elsewhere in Redis before this process's own calls
   * would otherwise discover it. A client that omits it just skips that
   * startup seeding, same as no client having it at all.
   */
  scan?(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
}

/**
 * A second, dedicated connection used only for pub/sub. Redis clients in
 * subscribe mode cannot run other commands, so this must be a separate
 * connection from the one passed as RedisClient. ioredis's `duplicate()`
 * produces exactly this.
 */
export interface RedisSubscriber {
  subscribe(channel: string): Promise<unknown>;
  /** Optional: lets `dispose()` detach cleanly. Adapters skip it if the client has none. */
  unsubscribe?(channel: string): Promise<unknown> | unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
}
