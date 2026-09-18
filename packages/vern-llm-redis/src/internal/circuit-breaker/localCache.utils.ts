import type { CircuitState } from 'vern-llm';

/**
 * One key's locally cached view of a Redis-backed circuit: what
 * `assertClosed` reads to decide synchronously, and what every
 * transition (a recorded outcome, a pub/sub message, or a background
 * poll) writes back after confirming the real state in Redis.
 */
export interface LocalCircuitBucket {
  state: CircuitState;
  failures: number;
  openedAt: number;
  /**
   * True only while this process holds a Redis-confirmed half-open
   * trial it hasn't used yet (see TRANSITION_SCRIPT's wonProbe). Never
   * set optimistically, only after an async transition() result
   * confirms this process actually won the lease, so assertClosed can
   * make its synchronous allow/deny decision without ever guessing.
   */
  trialAvailable: boolean;
}

/**
 * Per-key local mirror of Redis-backed circuit state. Exists because
 * `assertClosed` must throw synchronously (that's its signature in
 * vern-llm), but Redis is async: every real decision has to be made
 * against whatever this cache says *right now*, with Redis calls only
 * ever refreshing it after the fact. Isolated into its own module so
 * that refresh-then-decide logic is testable as plain data in, data out,
 * without a fake Redis client anywhere in the test.
 */
export interface LocalCircuitCache {
  /** Reads key's cached bucket, creating and storing a fresh closed one on first access rather than returning undefined, so every caller can read unconditionally. */
  get(key: string): LocalCircuitBucket;
  /** Overwrites key's cached bucket wholesale, the shape every real transition (Redis confirmed or pub/sub delivered) is written back as. */
  set(key: string, bucket: LocalCircuitBucket): void;
  /** Every key this cache has ever been asked about, the set a background poll (see redisCircuitBreaker's pollIntervalMs) re-checks against Redis. */
  keys(): IterableIterator<string>;
}

export function createLocalCircuitCache(): LocalCircuitCache {
  const cache = new Map<string, LocalCircuitBucket>();

  return {
    get(key) {
      let bucket = cache.get(key);
      if (!bucket) {
        bucket = { state: 'closed', failures: 0, openedAt: 0, trialAvailable: false };
        cache.set(key, bucket);
      }
      return bucket;
    },

    set(key, bucket) {
      cache.set(key, bucket);
    },

    keys() {
      return cache.keys();
    },
  };
}
