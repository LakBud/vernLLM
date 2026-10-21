import { parseSnapshotResult, READ_BUCKETS_SCRIPT } from '../scripts/snapshotScript.js';
import { escapeGlob } from './bucketKey.utils.js';

import type { RedisClient } from '../../../types.js';
import type { LocalCircuitCache } from './localCache.utils.js';

/**
 * Seeds the local cache at startup with circuits already open elsewhere.
 * Reads only `keyPrefix` and keys under `keyPrefix:`. Does nothing without `scan`.
 */
export async function seedFromScan(
  redis: RedisClient,
  local: LocalCircuitCache,
  keyPrefix: string,
  isDisposed: () => boolean,
): Promise<void> {
  if (!redis.scan) return;

  const isOwnKey = (key: string) => key === keyPrefix || key.startsWith(`${keyPrefix}:`);

  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${escapeGlob(keyPrefix)}*`,
      'COUNT',
      1000,
    );
    cursor = nextCursor;

    for (const key of keys) {
      if (isDisposed()) return;
      if (!isOwnKey(key)) continue;

      const entry = parseSnapshotResult(await redis.eval(READ_BUCKETS_SCRIPT, 1, key));
      if (!entry) continue;

      // Anything this process heard meanwhile is newer than the snapshot.
      if (!local.isPristine(entry.key)) continue;

      local.set(entry.key, {
        state: entry.state,
        failures: entry.failures,
        openedAt: entry.openedAt,
        trialsHeld: 0,
        trialToken: '',
        breakdown: {},
        // No clock or cooldown in a snapshot: `prepare` asks before trusting it.
        serverOffset: 0,
        cooldownMs: 0,
        slots: 0,
        grantAt: 0,
        version: entry.version,
      });
    }
  } while (cursor !== '0');
}
