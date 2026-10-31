import { createLookup } from './lookup.js';
import { createView } from './view.js';

import type { HostedConfig, HostedDetector } from './types.js';

export type { Analyze, Hit, HostedConfig, HostedDetector } from './types.js';

/**
 * The part every hosted detector shares: views by kind, one request per text however many views
 * ask, a cache of labels and offsets (never text), and a limit on requests in flight. What a
 * provider answers lives in `analyze`.
 */
export function createHosted<Kind extends string>(
  config: HostedConfig<Kind>,
): HostedDetector<Kind> {
  const { name, kinds, kindOf, analyze, concurrency, cache, images, levels } = config;
  const lookup = createLookup({ name, analyze, concurrency, cache });

  return createView({ name, kinds, kindOf, lookup, images, levels });
}
