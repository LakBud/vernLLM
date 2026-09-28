import type { Bucket } from './buckets.utils.js';
import type { RateLimitState } from 'vern-llm';

/** Writes one bucket's reading into the matching RateLimitState field. */
export function setStateField(
  state: RateLimitState,
  bucket: Bucket,
  avail: number,
  cap: number,
): void {
  if (bucket.reason === 'rpm') state.requestsRemaining = avail;
  else if (bucket.reason === 'tpm') state.tokensRemaining = avail;
  else state.concurrentInFlight = Math.max(0, cap - avail);
}

/** What this process last saw of each bucket, for the synchronous `getState`. */
export interface Snapshots {
  observe(bucket: Bucket, avail: number, cap: number): void;
  /** Applies this process's own change before the next take. */
  adjust(bucket: Bucket, delta: number): void;
  /** Every bucket, per minute ones refilled forward to now. */
  view(): RateLimitState;
}

export function createSnapshots(buckets: Bucket[]): Snapshots {
  // Seeded full, for a process that has made no call yet.
  const snapshots = new Map<string, { avail: number; cap: number; at: number }>(
    buckets.map((bucket) => [
      bucket.key,
      { avail: bucket.initialCapacity, cap: bucket.initialCapacity, at: performance.now() },
    ]),
  );

  return {
    observe(bucket, avail, cap) {
      snapshots.set(bucket.key, { avail, cap, at: performance.now() });
    },

    adjust(bucket, delta) {
      const snap = snapshots.get(bucket.key)!;
      snap.avail = Math.min(snap.cap, snap.avail + delta);
    },

    view() {
      const state: RateLimitState = {};
      const now = performance.now();

      for (const bucket of buckets) {
        const snap = snapshots.get(bucket.key)!;
        const avail =
          bucket.rateMode === 'permin'
            ? Math.min(snap.cap, snap.avail + ((now - snap.at) * snap.cap) / 60_000)
            : snap.avail;
        setStateField(state, bucket, avail, snap.cap);
      }

      return state;
    },
  };
}
