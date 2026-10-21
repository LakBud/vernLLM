import type { LocalCircuitCache } from '../state/localCache.utils.js';

/**
 * Whether asking Redis could change `assertClosed`: a key never seen, an
 * open circuit past its cooldown, or half-open without a slot when one is
 * free or the holder's lease has lapsed.
 */
export function needsRefresh(local: LocalCircuitCache, key: string, probeLeaseMs: number): boolean {
  if (local.isPristine(key)) return true;

  const bucket = local.get(key);
  const serverNow = Date.now() + bucket.serverOffset;

  if (bucket.state === 'open') return serverNow - bucket.openedAt >= bucket.cooldownMs;
  if (bucket.state === 'half-open' && bucket.trialsHeld === 0) {
    return bucket.slots > 0 || (bucket.grantAt > 0 && serverNow - bucket.grantAt >= probeLeaseMs);
  }
  return false;
}

/** One refresh per key at a time, shared by the calls that ask meanwhile. */
export interface Refresher {
  run(key: string, refresh: () => Promise<void>): Promise<void>;
  clear(): void;
}

export function createRefresher(prepareTimeoutMs: number): Refresher {
  const running = new Map<string, { promise: Promise<void>; startedAt: number }>();

  return {
    run(key, refresh) {
      const current = running.get(key);
      if (current) {
        // Past the timeout Redis is slow: go ahead on local state instead of waiting.
        return Date.now() - current.startedAt >= prepareTimeoutMs
          ? Promise.resolve()
          : current.promise;
      }

      const promise = (async () => {
        try {
          await refresh();
        } finally {
          running.delete(key);
        }
      })();
      running.set(key, { promise, startedAt: Date.now() });
      return promise;
    },

    clear() {
      running.clear();
    },
  };
}
