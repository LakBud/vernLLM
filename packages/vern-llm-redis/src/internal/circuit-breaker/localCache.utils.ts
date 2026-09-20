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
   * How many Redis-confirmed half-open trial slots this process holds and
   * has not spent yet (see TRANSITION_SCRIPT's wonProbe). Never set
   * optimistically, only after an async transition() result confirms this
   * process actually won them, so assertClosed can make its synchronous
   * allow/deny decision without ever guessing.
   *
   * A count, not a flag: background checks can overlap, and each one that
   * wins a slot in Redis is a slot this process now owns. Folding them
   * into one flag would strand the rest until their lease ran out.
   */
  trialsHeld: number;
  /** The half-open epoch those slots belong to. Only meaningful while `trialsHeld` is above 0. */
  trialToken: string;
  /** Failure counts by error code, as last reported by Redis. */
  breakdown: Record<string, number>;
  /** Redis's clock minus this process's, in ms, as of the last report. Adding it to `Date.now()` estimates Redis's time without asking. */
  serverOffset: number;
  /** The cooldown in force, in ms, as last reported by Redis. */
  cooldownMs: number;
  /** Half-open trial slots not yet handed out, as last reported by Redis. */
  slots: number;
  /** When the latest half-open slot was handed out, on Redis's clock, or 0. */
  grantAt: number;
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
  /** True while `key` is still exactly the fresh closed bucket `get` creates: nothing has ever been written to it. */
  isPristine(key: string): boolean;
}

function freshBucket(): LocalCircuitBucket {
  return {
    state: 'closed',
    failures: 0,
    openedAt: 0,
    trialsHeld: 0,
    trialToken: '',
    breakdown: {},
    serverOffset: 0,
    cooldownMs: 0,
    slots: 0,
    grantAt: 0,
  };
}

export function createLocalCircuitCache(): LocalCircuitCache {
  const cache = new Map<string, LocalCircuitBucket>();
  const written = new Set<string>();

  return {
    get(key) {
      let bucket = cache.get(key);
      if (!bucket) {
        bucket = freshBucket();
        cache.set(key, bucket);
      }
      return bucket;
    },

    set(key, bucket) {
      cache.set(key, bucket);
      written.add(key);
    },

    keys() {
      return cache.keys();
    },

    isPristine(key) {
      return !written.has(key);
    },
  };
}
