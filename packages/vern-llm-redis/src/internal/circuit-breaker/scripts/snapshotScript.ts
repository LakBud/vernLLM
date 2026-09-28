import type { CircuitState } from 'vern-llm';

/**
 * Reads one bucket (KEYS[1]), non closed only unless ARGV[1] is '1'. One
 * key per call so a cluster routes it. Skips the pub/sub channel key, which
 * the startup SCAN also matches.
 */
export const READ_BUCKETS_SCRIPT = `
local key = KEYS[1]

if redis.call('TYPE', key)['ok'] ~= 'hash' then
  return nil
end

local h = redis.call('HMGET', key, 'state', 'failures', 'openedAt', 'ver')
local state = h[1]
if not state or (state == 'closed' and ARGV[1] ~= '1') then
  return nil
end

return { key, state, h[2] or '0', h[3] or '0', h[4] or '0' }
`;

export interface SnapshotEntry {
  key: string;
  state: CircuitState;
  failures: number;
  openedAt: number;
  /** The transition version, 0 if none yet. */
  version: number;
}

/** Parses a READ_BUCKETS_SCRIPT reply, or null. */
export function parseSnapshotResult(raw: unknown): SnapshotEntry | null {
  if (!raw) return null;
  const [key, state, failures, openedAt, version] = raw as string[];
  const parsedVersion = Number(version);

  return {
    key: key!,
    state: state as CircuitState,
    failures: Number(failures),
    openedAt: Number(openedAt),
    version: Number.isFinite(parsedVersion) && parsedVersion > 0 ? parsedVersion : 0,
  };
}
