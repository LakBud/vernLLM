import type { StatsApi } from '../../types/index.js';
import type { SeriesRegistry } from './seriesRegistry.js';

/** The public read side of the registry. Nothing here changes what the registry records. */
export function createStatsApi(registry: SeriesRegistry): StatsApi {
  return {
    snapshot: () => registry.snapshot(),
    quantile: (filter, q, metric) => registry.quantile(filter, q, metric),
    reset: () => registry.reset(),
  };
}
