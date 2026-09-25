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
 * Whether `structuredClone` returns a faithful copy of `value`: plain
 * objects and arrays, primitives, and the built-ins it recreates with
 * their own type (Date, RegExp, Map, Set, binary data), all the way down.
 * A class instance would come back as a plain object without its
 * methods, and a function or symbol can't be cloned at all, so either
 * anywhere in the value makes it unsafe to copy.
 */
function isFaithfullyCloneable(value: unknown, seen = new Set<object>()): boolean {
  if (value === null) return true;

  const type = typeof value;
  if (type === 'function' || type === 'symbol') return false;
  if (type !== 'object') return true;

  const object = value as object;
  if (seen.has(object)) return true;
  seen.add(object);

  if (
    object instanceof Date ||
    object instanceof RegExp ||
    object instanceof ArrayBuffer ||
    ArrayBuffer.isView(object)
  ) {
    return true;
  }

  if (object instanceof Map) {
    for (const [key, item] of object) {
      if (!isFaithfullyCloneable(key, seen) || !isFaithfullyCloneable(item, seen)) return false;
    }
    return true;
  }

  if (object instanceof Set) {
    for (const item of object) {
      if (!isFaithfullyCloneable(item, seen)) return false;
    }
    return true;
  }

  const prototype = Object.getPrototypeOf(object);
  if (!Array.isArray(object) && prototype !== Object.prototype && prototype !== null) return false;

  // Symbol keys and accessors are dropped or flattened by structuredClone.
  if (Object.getOwnPropertySymbols(object).length > 0) return false;

  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(object))) {
    if (!('value' in descriptor)) return false;
    if (!isFaithfullyCloneable(descriptor.value, seen)) return false;
  }

  return true;
}

/**
 * Trivial default so the package works out of the box with no external deps.
 * Not shared across processes, swap in Redis/Upstash/etc for production.
 *
 * Values are copied on `set` and on every `get`, so mutating a result
 * never changes what the next hit returns. A value that can't be copied
 * faithfully (a class instance, a function, anywhere inside it) is not
 * stored, and drops any existing entry for the key, since the store would
 * otherwise have to share it or hand back a copy without its methods. A
 * `ttl` that is missing, NaN, zero, or negative is treated the same way,
 * since an entry that can't expire would be served forever.
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
    // Only faithfully cloneable values are ever stored, see `set`.
    return { hit: true, value: structuredClone(entry.value) };
  }

  async set(key: string, value: T, ttl: number): Promise<void> {
    this.cleanupExpiredEntries();

    if (!isLiveTtl(ttl) || !isFaithfullyCloneable(value)) {
      // The caller asked to replace this key, so an older value must not survive.
      this.store.delete(key);
      return;
    }

    this.store.set(key, {
      value: structuredClone(value),
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
  /** L2 expiry (epoch ms) per key this adapter wrote, oldest write first. */
  private readonly l2ExpiresAt = new Map<string, number>();

  /**
   * The same expiries as a min-heap, soonest first, so a write only visits
   * records that have actually expired. Entries go stale when their key is
   * rewritten, deleted, or capped out, and are skipped when popped: a heap
   * entry only counts while the map still holds that exact expiry.
   */
  private expiryHeap: Array<{ key: string; expiresAt: number }> = [];

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

    // L2 still served a key whose tracked write has expired, so another
    // process rewrote it since. The record describes an entry that no
    // longer exists; treat the hit like any other external entry.
    if (expiresAt <= Date.now()) {
      this.l2ExpiresAt.delete(key);
      return fallback;
    }

    return Math.min(fallback, (expiresAt - Date.now()) / 1000);
  }

  private trackExpiry(key: string, ttl: number): void {
    const now = Date.now();

    this.pruneExpired(now);

    // Reinserted so the map's order stays oldest write first for the cap below.
    this.l2ExpiresAt.delete(key);

    // A ttl that isn't a number stays untracked, so promotion falls back to l1Ttl.
    if (typeof ttl !== 'number' || Number.isNaN(ttl)) return;

    const expiresAt = now + ttl * 1000;
    this.l2ExpiresAt.set(key, expiresAt);
    heapPush(this.expiryHeap, { key, expiresAt });

    while (this.l2ExpiresAt.size > MAX_TRACKED_EXPIRIES) {
      const oldest = this.l2ExpiresAt.keys().next().value;
      /* v8 ignore next */
      if (oldest === undefined) break;
      this.l2ExpiresAt.delete(oldest);
    }

    // Stale heap entries (rewrites, deletes, capped keys) would otherwise
    // pile up for keys that never expire soon. Rebuilding from the map is
    // O(n) and only runs once the heap holds twice what it needs.
    if (this.expiryHeap.length > 2 * this.l2ExpiresAt.size + 64) {
      this.expiryHeap = [];
      for (const [trackedKey, trackedExpiry] of this.l2ExpiresAt) {
        heapPush(this.expiryHeap, { key: trackedKey, expiresAt: trackedExpiry });
      }
    }
  }

  /** Drops every tracked record that has expired, visiting only those. */
  private pruneExpired(now: number): void {
    while (this.expiryHeap.length > 0 && this.expiryHeap[0]!.expiresAt <= now) {
      const { key, expiresAt } = heapPop(this.expiryHeap)!;
      if (this.l2ExpiresAt.get(key) === expiresAt) this.l2ExpiresAt.delete(key);
    }
  }
}

type ExpiryRecord = { key: string; expiresAt: number };

/** Adds `record` to a min-heap ordered by `expiresAt`. */
function heapPush(heap: ExpiryRecord[], record: ExpiryRecord): void {
  heap.push(record);
  let index = heap.length - 1;

  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (heap[parent]!.expiresAt <= heap[index]!.expiresAt) break;
    [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
    index = parent;
  }
}

/** Removes and returns the soonest record of a min-heap ordered by `expiresAt`. */
function heapPop(heap: ExpiryRecord[]): ExpiryRecord | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (top === undefined || last === undefined || heap.length === 0) return top;

  heap[0] = last;
  let index = 0;

  for (;;) {
    const left = 2 * index + 1;
    const right = left + 1;
    let smallest = index;

    if (left < heap.length && heap[left]!.expiresAt < heap[smallest]!.expiresAt) smallest = left;
    if (right < heap.length && heap[right]!.expiresAt < heap[smallest]!.expiresAt) smallest = right;
    if (smallest === index) return top;

    [heap[smallest], heap[index]] = [heap[index]!, heap[smallest]!];
    index = smallest;
  }
}
