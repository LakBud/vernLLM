import type { CircuitState } from 'vern-llm';

/**
 * Reads state/failures/openedAt for every key in ARGV and returns the
 * non-closed ones. Keys come from a JS-side SCAN loop (RedisClient.scan),
 * not from inside this script, so a full keyspace walk never blocks
 * Redis for the duration of one Lua call the way a SCAN loop embedded in
 * a script would on a large keyspace. Run once per adapter construction,
 * fire-and-forget, to seed a fresh process's local cache with any
 * circuit already open elsewhere in Redis before this process's own
 * calls would otherwise discover it.
 *
 * TYPE-guards each key before HGET: `keyPrefix:events`, the pub/sub
 * channel this same prefix publishes on, matches the SCAN pattern too
 * but isn't a hash.
 */
export const READ_BUCKETS_SCRIPT = `
local results = {}

for i = 1, #ARGV do
  local key = ARGV[i]
  if redis.call('TYPE', key)['ok'] == 'hash' then
    local state = redis.call('HGET', key, 'state')
    if state and state ~= 'closed' then
      local failures = redis.call('HGET', key, 'failures') or '0'
      local openedAt = redis.call('HGET', key, 'openedAt') or '0'
      table.insert(results, key)
      table.insert(results, state)
      table.insert(results, failures)
      table.insert(results, openedAt)
    end
  end
end

return results
`;

export interface SnapshotEntry {
  key: string;
  state: CircuitState;
  failures: number;
  openedAt: number;
}

/** Parses READ_BUCKETS_SCRIPT's flat [key, state, failures, openedAt, ...] return value. */
export function parseSnapshotResult(raw: unknown): SnapshotEntry[] {
  const flat = raw as string[];
  const entries: SnapshotEntry[] = [];

  for (let i = 0; i < flat.length; i += 4) {
    entries.push({
      key: flat[i]!,
      state: flat[i + 1] as CircuitState,
      failures: Number(flat[i + 2]),
      openedAt: Number(flat[i + 3]),
    });
  }

  return entries;
}
