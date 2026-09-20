import { parseSnapshotResult, READ_BUCKETS_SCRIPT } from './snapshotScript.js';

import type { RedisClient } from '../../types.js';
import type { LocalCircuitCache } from './localCache.utils.js';

/**
 * One time startup scan: seeds the local cache with any circuit already
 * open elsewhere in Redis, so a fresh process doesn't default an unseen
 * key to closed. Resolves at once if the client has no `scan`.
 */
export async function seedFromScan(
  redis: RedisClient,
  local: LocalCircuitCache,
  keyPrefix: string,
  isDisposed: () => boolean,
): Promise<void> {
  if (!redis.scan) return;

  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${keyPrefix}*`, 'COUNT', 1000);
    cursor = nextCursor;

    for (const key of keys) {
      if (isDisposed()) return;

      const entry = parseSnapshotResult(await redis.eval(READ_BUCKETS_SCRIPT, 1, key));
      if (!entry) continue;

      // This scan is slow and this process may have already heard about
      // the key from a pub/sub message or its own call. That is newer
      // than a snapshot read earlier, so never overwrite it.
      if (!local.isPristine(entry.key)) continue;

      local.set(entry.key, {
        state: entry.state,
        failures: entry.failures,
        openedAt: entry.openedAt,
        trialsHeld: 0,
        trialToken: '',
        breakdown: {},
        // A snapshot carries no clock or cooldown, so a seeded open
        // circuit reads as "cooldown may be over" until `prepare` asks.
        serverOffset: 0,
        cooldownMs: 0,
        slots: 0,
        grantAt: 0,
      });
    }
  } while (cursor !== '0');
}
