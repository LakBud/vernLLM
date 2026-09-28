/** The Redis client shape every adapter needs. A real ioredis `Redis` matches it. */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', durationMs: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  /** Optional. Runs a cached script by SHA1, so its source is sent once. */
  evalsha?(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  /** Optional, ioredis's shape. Only seeds the breaker's startup cache. */
  scan?(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
}

/** A dedicated pub/sub connection, separate from the command one. ioredis's `duplicate()` gives one. */
export interface RedisSubscriber {
  subscribe(channel: string): Promise<unknown>;
  /** Optional. Lets `dispose()` leave the channel. */
  unsubscribe?(channel: string): Promise<unknown> | unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  /** Optional. Lets `dispose()` remove its listener. */
  off?(event: 'message', listener: (channel: string, message: string) => void): unknown;
}
