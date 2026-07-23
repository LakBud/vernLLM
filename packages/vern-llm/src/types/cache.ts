export interface CacheAdapter<T = unknown> {
  get(key: string): Promise<T | null>;
  set(key: string, value: T, ttl: number): Promise<void>;
  delete?(key: string): Promise<void>;
}

/**
 * Trivial default so the package works out of the box with no external deps
 * Not shared across processes, swap in Redis/Upstash/etc for production
 */
export class InMemoryCacheAdapter<T = unknown> implements CacheAdapter<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();

  async get(key: string): Promise<T | null> {
    const entry = this.store.get(key);

    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(key: string, value: T, ttl: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl * 1000,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
