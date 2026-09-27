import type { CallMeta } from '../../../types/index.js';

export type MetaHolder = { current?: CallMeta };

/**
 * Returns the `CallMeta` holder shared by every `cachedCall()` in flight for
 * `key`, so a joiner reports the trigger's metadata. A hit never creates one,
 * so it still reports none.
 *
 * `release` is a no-op for joiners. For the creator it deletes the holder once
 * the key's in-flight work settles, looked up at release time.
 */
export function claimMetaHolder(
  holders: Map<string, MetaHolder>,
  key: string,
  inFlightFor: (key: string) => Promise<unknown> | undefined,
): { holder: MetaHolder; release: () => void } {
  const existing = holders.get(key);
  if (existing) return { holder: existing, release: () => {} };

  const holder: MetaHolder = {};
  holders.set(key, holder);

  const release = () => {
    const deleteHolder = () => holders.delete(key);
    const shared = inFlightFor(key);

    if (shared) void shared.then(deleteHolder, deleteHolder);
    else deleteHolder();
  };

  return { holder, release };
}
