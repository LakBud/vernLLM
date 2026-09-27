import type { AdapterInfo, LLMClient } from '../../types/client.js';

/** What middleware see for a client that doesn't identify its adapter. */
export const CUSTOM_ADAPTER: AdapterInfo = Object.freeze({ name: 'custom' });

/**
 * `client.adapter`, copied and frozen so one middleware can't change what
 * the next one reads, or `CUSTOM_ADAPTER` when the client sets none. A
 * blank `name` counts as none, since it can't tell adapters apart.
 */
export function resolveAdapterInfo(client: LLMClient): AdapterInfo {
  const info = client.adapter;

  if (!info || typeof info.name !== 'string' || info.name.trim() === '') return CUSTOM_ADAPTER;

  return Object.freeze(
    typeof info.provider === 'string' && info.provider.trim() !== ''
      ? { name: info.name, provider: info.provider }
      : { name: info.name },
  );
}
