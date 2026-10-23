import type { StatsSource } from '../types/index.js';

/** Most distinct reads kept. A chain has a handful of targets, so this is only a safety cap. */
const MAX_ENTRIES = 512;

interface Entry {
  at: number;
  value: number | undefined;
}

/**
 * Reuses stats reads for `ttlMs`, which keeps the logger's quantile merge off the hot path.
 * A read that throws is not cached, so it is tried again on the next call.
 */
export class StatsCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly source: StatsSource,
    private readonly ttlMs: number,
  ) {}

  private read(key: string, now: number, load: () => number | undefined): number | undefined {
    if (this.ttlMs > 0) {
      const hit = this.entries.get(key);
      if (hit && now - hit.at >= 0 && now - hit.at < this.ttlMs) return hit.value;
    }

    const value = load();
    if (this.ttlMs > 0) {
      if (this.entries.size >= MAX_ENTRIES) this.entries.clear();
      this.entries.set(key, { at: now, value });
    }
    return value;
  }

  private static key(kind: string, filter: Readonly<Record<string, string>>, rest: string): string {
    const parts = Object.entries(filter).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `${kind}|${JSON.stringify(parts)}|${rest}`;
  }

  quantile(
    filter: Readonly<Record<string, string>>,
    q: number,
    metric: string,
    now: number,
  ): number | undefined {
    return this.read(StatsCache.key('q', filter, `${q}|${metric}`), now, () =>
      this.source.quantile(filter, q, metric),
    );
  }

  failureRate(filter: Readonly<Record<string, string>>, now: number): number | undefined {
    return this.read(StatsCache.key('f', filter, 'quality'), now, () =>
      this.source.failureRate?.(filter, 'quality'),
    );
  }

  get size(): number {
    return this.entries.size;
  }
}
