export interface CacheAdapter<T = unknown> {
  get(key: string): Promise<{ hit: boolean; value: T | null }>;
  set(key: string, value: T, ttl: number): Promise<void>;
  delete?(key: string): Promise<void>;
  resolveKey?(key: string): Promise<string>;
}

/**
 * Which entry `InMemoryCacheAdapter` evicts once `maxSize` is exceeded.
 * `'fifo'` (default) drops the oldest inserted entry. `'lru'` drops the
 * least recently read or written entry.
 */
export type EvictionOption = 'fifo' | 'lru';

/** Not exported. `onAccess`/`onInsert` mark recency, `getEvictee` picks the next victim. */
interface Eviction {
  onAccess(store: Map<string, unknown>, key: string): void;
  onInsert(store: Map<string, unknown>, key: string): void;
  getEvictee(store: Map<string, unknown>): string | undefined;
}

const FIFO: Eviction = {
  onAccess() {},
  onInsert() {},
  getEvictee: (store) => store.keys().next().value,
};

/** Moves `key` to the end of `store`'s iteration order. No-op if `key` isn't present. */
function touch(store: Map<string, unknown>, key: string): void {
  if (!store.has(key)) return;

  const value = store.get(key);
  store.delete(key);
  store.set(key, value);
}

const LRU: Eviction = {
  onAccess: touch,
  onInsert: touch,
  getEvictee: (store) => store.keys().next().value,
};

/** Not exported. Resolves the shorthand into the shared `Eviction` instance. */
function buildEviction(option: EvictionOption): Eviction {
  return option === 'lru' ? LRU : FIFO;
}

/**
 * Trivial default so the package works out of the box with no external deps.
 * Not shared across processes, swap in Redis/Upstash/etc for production.
 */
export class InMemoryCacheAdapter<T = unknown> implements CacheAdapter<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();
  private readonly eviction: Eviction;

  constructor(
    private readonly maxSize = 1000,
    eviction: EvictionOption = 'fifo',
  ) {
    this.eviction = buildEviction(eviction);
  }

  async get(key: string): Promise<{ hit: boolean; value: T | null }> {
    const entry = this.store.get(key);

    if (!entry) return { hit: false, value: null };

    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return { hit: false, value: null };
    }

    this.eviction.onAccess(this.store, key);
    return { hit: true, value: entry.value };
  }

  async set(key: string, value: T, ttl: number): Promise<void> {
    this.cleanupExpiredEntries();

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl * 1000,
    });
    this.eviction.onInsert(this.store, key);

    this.enforceSizeLimit();
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  private cleanupExpiredEntries(): void {
    const now = Date.now();

    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  private enforceSizeLimit(): void {
    while (this.store.size > this.maxSize) {
      const victim = this.eviction.getEvictee(this.store);

      if (victim === undefined) break;

      this.store.delete(victim);
    }
  }
}

/**
 * Normalizes keys before caching to avoid duplicate entries from formatting differences.
 */
export class NormalizedCacheAdapter<T = unknown> implements CacheAdapter<T> {
  constructor(private readonly inner: CacheAdapter<T> = new InMemoryCacheAdapter<T>()) {}

  private normalize(key: string): string {
    return key
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async resolveKey(key: string): Promise<string> {
    return this.normalize(key);
  }

  async get(key: string): Promise<{ hit: boolean; value: T | null }> {
    return this.inner.get(this.normalize(key));
  }

  async set(key: string, value: T, ttl: number): Promise<void> {
    await this.inner.set(this.normalize(key), value, ttl);
  }

  async delete(key: string): Promise<void> {
    await this.inner.delete?.(this.normalize(key));
  }
}

/**
 * Two-tier cache with fast local L1 and shared L2.
 * L2 hits are promoted back to L1.
 */
export class TieredCacheAdapter<T = unknown> implements CacheAdapter<T> {
  constructor(
    private readonly l1: CacheAdapter<T>,
    private readonly l2: CacheAdapter<T>,
    private readonly l1Ttl?: number,
  ) {}

  /**
   * Forwards to L1's `resolveKey` if it has one, otherwise L2's. L1 is
   * preferred since `get()` checks L1 first, so its notion of "the same
   * key" is the one that determines whether a lookup can skip L2 entirely.
   */
  async resolveKey(key: string): Promise<string> {
    if (this.l1.resolveKey) return this.l1.resolveKey(key);
    if (this.l2.resolveKey) return this.l2.resolveKey(key);
    return key;
  }

  async get(key: string): Promise<{ hit: boolean; value: T | null }> {
    const l1Result = await this.l1.get(key);
    if (l1Result.hit) return l1Result;

    const l2Result = await this.l2.get(key);

    if (l2Result.hit) {
      await this.l1.set(key, l2Result.value as T, this.l1Ttl ?? 60);
    }

    return l2Result;
  }

  async set(key: string, value: T, ttl: number): Promise<void> {
    await Promise.all([this.l1.set(key, value, this.l1Ttl ?? ttl), this.l2.set(key, value, ttl)]);
  }

  async delete(key: string): Promise<void> {
    await Promise.all([this.l1.delete?.(key), this.l2.delete?.(key)]);
  }
}
