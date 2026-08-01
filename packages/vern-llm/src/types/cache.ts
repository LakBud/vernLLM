export interface CacheAdapter<T = unknown> {
  get(key: string): Promise<{ hit: boolean; value: T | null }>;
  set(key: string, value: T, ttl: number): Promise<void>;
  delete?(key: string): Promise<void>;
  resolveKey?(key: string): Promise<string>;
}

/**
 * Trivial default so the package works out of the box with no external deps
 * Not shared across processes, swap in Redis/Upstash/etc for production
 */
export class InMemoryCacheAdapter<T = unknown> implements CacheAdapter<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly maxSize = 1000) {}

  async get(key: string): Promise<{ hit: boolean; value: T | null }> {
    const entry = this.store.get(key);

    if (!entry) return { hit: false, value: null };

    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return { hit: false, value: null };
    }

    return { hit: true, value: entry.value };
  }

  async set(key: string, value: T, ttl: number): Promise<void> {
    this.cleanupExpiredEntries();

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl * 1000,
    });

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
      const oldestKey = this.store.keys().next().value;

      if (oldestKey === undefined) break;

      this.store.delete(oldestKey);
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
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ');
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

  async get(key: string): Promise<{ hit: boolean; value: T | null }> {
    const l1Result = await this.l1.get(key);
    if (l1Result.hit) return l1Result;

    const l2Result = await this.l2.get(key);
    if (l2Result.hit && l2Result.value !== null) {
      await this.l1.set(key, l2Result.value, this.l1Ttl ?? 60);
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
