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
  // Defensive: both call sites (onAccess in get(), onInsert in set())
  // only invoke this after confirming the key is already in the store,
  // so this guard never actually trips today. Kept in case a future
  // eviction policy calls touch() from a context that can't make the
  // same guarantee.
  /* v8 ignore next */
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
 * True for a ttl that can actually expire an entry. `undefined` and NaN
 * would otherwise produce a NaN expiry that never compares as due, and a
 * zero or negative ttl is already expired on arrival.
 */
function isLiveTtl(ttl: number): boolean {
  return typeof ttl === 'number' && ttl > 0;
}

/**
 * Copies a value so the caller and the store never share one object. A
 * value `structuredClone` can't copy (a function, for one) is kept by
 * reference, since refusing to cache it would be a bigger surprise than
 * the sharing.
 */
function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/**
 * Trivial default so the package works out of the box with no external deps.
 * Not shared across processes, swap in Redis/Upstash/etc for production.
 *
 * Values are copied on `set` and on every `get`, so mutating a result
 * never changes what the next hit returns. A `ttl` that is missing, NaN,
 * zero, or negative stores nothing and drops any existing entry for the
 * key, since an entry that can't expire would be served forever.
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
    return { hit: true, value: cloneValue(entry.value) };
  }

  async set(key: string, value: T, ttl: number): Promise<void> {
    this.cleanupExpiredEntries();

    if (!isLiveTtl(ttl)) {
      // The caller asked to replace this key, so an older value must not survive.
      this.store.delete(key);
      return;
    }

    this.store.set(key, {
      value: cloneValue(value),
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
 * Normalizes keys before caching to avoid duplicate entries from formatting
 * differences that can't change a prompt's meaning: Unicode composition,
 * line ending style, and leading or trailing whitespace. Case, punctuation,
 * and inner whitespace are kept, since `"2+2"` and `"2-2"` (or indented
 * code) must never share an answer.
 */
export class NormalizedCacheAdapter<T = unknown> implements CacheAdapter<T> {
  constructor(private readonly inner: CacheAdapter<T> = new InMemoryCacheAdapter<T>()) {}

  private normalize(key: string): string {
    return key.normalize('NFC').replace(/\r\n?/g, '\n').trim();
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

/** Upper bound on tracked L2 expiries, so a long running process can't grow the map forever. */
const MAX_TRACKED_EXPIRIES = 10_000;

/**
 * Two-tier cache with fast local L1 and shared L2.
 * L2 hits are promoted back to L1.
 *
 * An L1 entry never outlives the L2 entry it mirrors when this adapter
 * wrote that L2 entry. L2 doesn't report how long an entry it holds has
 * left, so a promoted entry that another process wrote keeps `l1Ttl`
 * (60s by default).
 */
export class TieredCacheAdapter<T = unknown> implements CacheAdapter<T> {
  /** L2 expiry (epoch ms) per key this adapter wrote. */
  private readonly l2ExpiresAt = new Map<string, number>();

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
      await this.l1.set(key, l2Result.value as T, this.promotionTtl(key));
    }

    return l2Result;
  }

  async set(key: string, value: T, ttl: number): Promise<void> {
    this.trackExpiry(key, ttl);

    // An L1 ttl above the L2 ttl would keep serving the value after L2 dropped it.
    const l1Ttl = this.l1Ttl === undefined ? ttl : Math.min(this.l1Ttl, ttl);

    await Promise.all([this.l1.set(key, value, l1Ttl), this.l2.set(key, value, ttl)]);
  }

  async delete(key: string): Promise<void> {
    this.l2ExpiresAt.delete(key);
    await Promise.all([this.l1.delete?.(key), this.l2.delete?.(key)]);
  }

  /** L1 ttl for a promoted entry, capped at the seconds L2 has left when that is known. */
  private promotionTtl(key: string): number {
    const fallback = this.l1Ttl ?? 60;
    const expiresAt = this.l2ExpiresAt.get(key);

    if (expiresAt === undefined) return fallback;

    return Math.min(fallback, (expiresAt - Date.now()) / 1000);
  }

  private trackExpiry(key: string, ttl: number): void {
    const now = Date.now();

    for (const [trackedKey, expiresAt] of this.l2ExpiresAt) {
      if (now >= expiresAt) this.l2ExpiresAt.delete(trackedKey);
    }

    // Reinserted so the map's order stays oldest write first for the cap below.
    this.l2ExpiresAt.delete(key);

    // A ttl that isn't a number stays untracked, so promotion falls back to l1Ttl.
    if (typeof ttl !== 'number' || Number.isNaN(ttl)) return;

    this.l2ExpiresAt.set(key, now + ttl * 1000);

    while (this.l2ExpiresAt.size > MAX_TRACKED_EXPIRIES) {
      const oldest = this.l2ExpiresAt.keys().next().value;
      /* v8 ignore next */
      if (oldest === undefined) break;
      this.l2ExpiresAt.delete(oldest);
    }
  }
}
