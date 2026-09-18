import type { CircuitState } from 'vern-llm';

/**
 * Reads state/failures/openedAt for a single bucket (KEYS[1]) and returns
 * it only if non-closed. Keys come from a JS-side SCAN loop
 * (RedisClient.scan), not from inside this script, so a full keyspace
 * walk never blocks Redis for the duration of one Lua call the way a
 * SCAN loop embedded in a script would on a large keyspace. Run once per
 * adapter construction, fire-and-forget, to seed a fresh process's local
 * cache with any circuit already open elsewhere in Redis before this
 * process's own calls would otherwise discover it.
 *
 * Takes exactly one key via KEYS rather than many via ARGV so Redis can
 * route the call to the right slot/shard in cluster mode; the caller
 * evaluates this once per bucket.
 *
 * TYPE-guards the key before HGET: `keyPrefix:events`, the pub/sub
 * channel this same prefix publishes on, matches the SCAN pattern too
 * but isn't a hash.
 */
export const READ_BUCKETS_SCRIPT = `
local key = KEYS[1]

if redis.call('TYPE', key)['ok'] ~= 'hash' then
  return nil
end

local state = redis.call('HGET', key, 'state')
if not state or state == 'closed' then
  return nil
end

local failures = redis.call('HGET', key, 'failures') or '0'
local openedAt = redis.call('HGET', key, 'openedAt') or '0'

return { key, state, failures, openedAt }
`;

export interface SnapshotEntry {
  key: string;
  state: CircuitState;
  failures: number;
  openedAt: number;
}

/** Parses READ_BUCKETS_SCRIPT's [key, state, failures, openedAt] return value, or null. */
export function parseSnapshotResult(raw: unknown): SnapshotEntry | null {
  if (!raw) return null;
  const [key, state, failures, openedAt] = raw as string[];

  return {
    key: key!,
    state: state as CircuitState,
    failures: Number(failures),
    openedAt: Number(openedAt),
  };
}
