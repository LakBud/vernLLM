import type { ResolvedConfig } from '../../types/index.js';
import type { Guard } from '../guard.utils.js';

const MS_PER_DAY = 86_400_000;

/** Warns once, at construction, when the price table is older than `maxPriceAgeDays`. */
export function warnIfPricesStale(
  config: Pick<ResolvedConfig, 'pricesAsOf' | 'pricesAsOfMs' | 'maxPriceAgeDays'>,
  guard: Guard,
): void {
  if (config.pricesAsOfMs === undefined) return;

  const ageDays = (Date.now() - config.pricesAsOfMs) / MS_PER_DAY;
  if (ageDays > config.maxPriceAgeDays) {
    guard.warn(
      `prices are ${Math.floor(ageDays)} days old (as of ${config.pricesAsOf}), check them`,
    );
  }
}
