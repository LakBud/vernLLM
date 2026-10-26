import type { StatsSource } from '../../types/index.js';

/** Most distinct reads kept. A chain has a handful of targets, so this is only a safety cap. */
const MAX_ENTRIES = 512;

/** The one metric that means "time to the first answer" for plain and streamed calls alike. */
const METRIC = 'attemptMs';

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

  quantile(filter: Readonly<Record<string, string>>, q: number, now: number): number | undefined {
    const key = `${JSON.stringify(Object.entries(filter).sort(([a], [b]) => (a < b ? -1 : 1)))}|${q}`;

    if (this.ttlMs > 0) {
      const hit = this.entries.get(key);
      if (hit && now - hit.at >= 0 && now - hit.at < this.ttlMs) return hit.value;
    }

    const value = this.source.quantile(filter, q, METRIC);
    if (this.ttlMs > 0) {
      if (this.entries.size >= MAX_ENTRIES) this.entries.clear();
      this.entries.set(key, { at: now, value });
    }
    return value;
  }

  get size(): number {
    return this.entries.size;
  }
}
