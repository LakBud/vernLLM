export interface CacheAdapter<T = unknown> {
  get(key: string): Promise<{ hit: boolean; value: T | null }>;
  set(key: string, value: T, ttl: number): Promise<void>;
  delete?(key: string): Promise<void>;
}

/**
 * Trivial default so the package works out of the box with no external deps
 * Not shared across processes, swap in Redis/Upstash/etc for production
 */
export class InMemoryCacheAdapter<T = unknown> implements CacheAdapter<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();
  private readonly cleanupBatchSize = 100;

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
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  private cleanupExpiredEntries(): void {
    const now = Date.now();
    let checked = 0;

    for (const [key, entry] of this.store) {
      if (checked >= this.cleanupBatchSize) break;

      if (now >= entry.expiresAt) {
        this.store.delete(key);
      }

      checked++;
    }
  }
}
