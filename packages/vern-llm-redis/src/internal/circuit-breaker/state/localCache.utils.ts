import type { CircuitState } from 'vern-llm';

/** One key's local view of a circuit, which `assertClosed` reads synchronously. */
export interface LocalCircuitBucket {
  state: CircuitState;
  failures: number;
  openedAt: number;
  /** Half-open slots Redis confirmed this process won and it hasn't spent. A count, since overlapping checks can each win one. */
  trialsHeld: number;
  /** The epoch those slots belong to. */
  trialToken: string;
  /** Failures by error code. */
  breakdown: Record<string, number>;
  /** Redis's clock minus this process's, in ms. */
  serverOffset: number;
  /** The cooldown in force, in ms. */
  cooldownMs: number;
  /** Slots not yet handed out. */
  slots: number;
  /** When the latest slot was granted, on Redis's clock, or 0. */
  grantAt: number;
  /** The newest transition version applied, or 0. */
  version: number;
}

/** A local mirror of every circuit, since `assertClosed` must decide synchronously. */
export interface LocalCircuitCache {
  /** The cached bucket, a fresh closed one on first read. */
  get(key: string): LocalCircuitBucket;
  /** Replaces the cached bucket. */
  set(key: string, bucket: LocalCircuitBucket): void;
  /** Every key ever read, the set the poll rechecks. */
  keys(): IterableIterator<string>;
  /** Whether `key` has never been written. */
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
    version: 0,
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
