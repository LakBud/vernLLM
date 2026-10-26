import { nextTargets } from '../../targets.js';
import { resolveAdapt } from './resolveAdapt.utils.js';
import { resolveCacheAware } from './resolveCacheAware.utils.js';
import { resolveDelay } from './resolveDelay.utils.js';
import { invalid, isNumber } from './validate.utils.js';

import type { HedgeOptions, ResolvedConfig } from '../../types/index.js';

function resolveBudget(budget: HedgeOptions['budget']): ResolvedConfig['budget'] {
  if (budget !== undefined && (typeof budget !== 'object' || budget === null)) {
    invalid('budget must be an object: { ratio?, burst? }');
  }

  const ratio = budget?.ratio ?? 0.05;
  const burst = budget?.burst ?? 10;

  if (!isNumber(ratio) || ratio <= 0 || ratio > 1) {
    invalid('budget.ratio must be a number above 0 and at most 1');
  }
  if (!isNumber(burst) || burst < 1) invalid('budget.burst must be a number of at least 1');

  return { ratio, burst };
}

/** Validates the options once, so a mistake fails at construction instead of mid call. */
export function normalizeOptions(options: HedgeOptions = {}): ResolvedConfig {
  const delay = resolveDelay(options.delay);

  if (options.stats !== undefined && typeof options.stats?.quantile !== 'function') {
    invalid('stats must have a quantile function');
  }
  if (delay.kind === 'quantile' && options.stats === undefined) {
    invalid(
      'stats must have a quantile function when delay is a quantile (pass logger.stats), ' +
        'or set delay to a number or a function',
    );
  }

  if (options.targets !== undefined && typeof options.targets !== 'function') {
    invalid('targets must be a function');
  }
  if (options.when !== undefined && typeof options.when !== 'function') {
    invalid('when must be a function');
  }

  const maxHedges = options.maxHedges ?? 1;
  if (!Number.isInteger(maxHedges) || maxHedges < 1 || maxHedges > 4) {
    invalid('maxHedges must be an integer from 1 to 4');
  }

  const statsTtlMs = options.statsTtlMs ?? 1_000;
  if (!isNumber(statsTtlMs) || statsTtlMs < 0) {
    invalid('statsTtlMs must be a number of at least 0');
  }

  return {
    stats: options.stats,
    delay,
    budget: resolveBudget(options.budget),
    maxHedges,
    adapt: resolveAdapt(options.adapt),
    cacheAware: resolveCacheAware(options.cacheAware),
    targets: options.targets ?? nextTargets,
    when: options.when ?? (() => true),
    statsTtlMs,
    logger: options.logger,
  };
}
