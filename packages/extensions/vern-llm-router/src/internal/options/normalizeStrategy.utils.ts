import { invalid } from './validate.utils.js';

import type {
  RankMetric,
  ResolvedLimits,
  ResolvedStrategy,
  RouteOptions,
  RouterOptions,
} from '../../types/index.js';

/** The sources a route can use, to check that what it asks for is there. */
export interface Sources {
  stats: boolean;
  statsFailureRate: boolean;
  cost: boolean;
}

const RANK_METRICS: readonly RankMetric[] = [
  'latency',
  'predictedLatency',
  'cost',
  'effectiveCost',
  'quality',
  'custom',
];

function resolveWeights(weights: unknown, route: RouteOptions): ReadonlyMap<string, number> {
  if (typeof weights !== 'object' || weights === null || Array.isArray(weights)) {
    invalid(`route "${route.name}": weights must be an object of names to numbers`);
  }
  const entries = Object.entries(weights);
  if (
    entries.some(([, value]) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
  ) {
    invalid(`route "${route.name}": weights must be finite numbers of at least 0`);
  }
  if (entries.length > 0 && entries.every(([, value]) => value === 0)) {
    invalid(`route "${route.name}": weights cannot all be 0`);
  }
  return new Map(entries as [string, number][]);
}

function requireSource(route: RouteOptions, what: string, present: boolean, source: string): void {
  if (!present) invalid(`route "${route.name}": ${what} needs the ${source} option`);
}

function resolveRank(
  route: RouteOptions,
  object: {
    weights?: unknown;
    q?: unknown;
    tolerance?: unknown;
    explore?: unknown;
    custom?: unknown;
  },
  sources: Sources,
): ResolvedStrategy {
  const weights = resolveWeights(object.weights ?? {}, route);
  const metrics = new Map<RankMetric, number>();
  for (const [name, weight] of weights) {
    if (!RANK_METRICS.includes(name as RankMetric)) {
      invalid(`route "${route.name}": unknown rank metric "${name}"`);
    }
    if (weight > 0) metrics.set(name as RankMetric, weight);
  }
  if (metrics.size === 0) invalid(`route "${route.name}": rank needs a metric with a weight`);

  const q = object.q ?? 0.95;
  if (typeof q !== 'number' || !(q > 0 && q < 1)) {
    invalid(`route "${route.name}": q must be a number between 0 and 1`);
  }
  const tolerance = object.tolerance ?? 0.2;
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
    invalid(`route "${route.name}": tolerance must be a number of at least 0`);
  }
  const explore = object.explore ?? 0.05;
  if (typeof explore !== 'number' || !(explore >= 0 && explore < 1)) {
    invalid(`route "${route.name}": explore must be a number from 0 up to 1`);
  }

  for (const metric of ['latency', 'predictedLatency', 'quality'] as const) {
    if (metrics.has(metric)) requireSource(route, `the ${metric} metric`, sources.stats, 'stats');
  }
  if (metrics.has('quality')) {
    requireSource(route, 'the quality metric', sources.statsFailureRate, 'stats.failureRate');
  }
  if (metrics.has('cost')) requireSource(route, 'the cost metric', sources.cost, 'cost');
  if (metrics.has('effectiveCost')) {
    requireSource(route, 'the effectiveCost metric', sources.cost, 'cost');
    requireSource(route, 'the effectiveCost metric', sources.statsFailureRate, 'stats.failureRate');
  }
  if (metrics.has('custom') && typeof object.custom !== 'function') {
    invalid(`route "${route.name}": weights.custom needs a custom function`);
  }

  return {
    type: 'rank',
    weights: metrics,
    q,
    tolerance,
    explore,
    custom: typeof object.custom === 'function' ? (object.custom as never) : undefined,
  };
}

const SHORTHANDS: Record<string, Partial<Record<RankMetric, number>>> = {
  latency: { latency: 1 },
  cost: { cost: 1 },
  balanced: { latency: 0.5, cost: 0.5 },
};

export function resolveStrategy(route: RouteOptions, sources: Sources): ResolvedStrategy {
  const option = route.strategy;
  if (option === undefined) return { type: 'ordered' };

  const type = typeof option === 'string' ? option : option?.type;
  const object = typeof option === 'object' && option !== null ? option : {};

  if (type === 'ordered') return { type: 'ordered' };
  if (type === 'least-busy') {
    const weights = (object as { weights?: unknown }).weights;
    return { type, weights: weights === undefined ? undefined : resolveWeights(weights, route) };
  }
  if (type === 'weighted') {
    const { weights, stickyBy } = object as { weights?: unknown; stickyBy?: unknown };
    if (weights === undefined) invalid(`route "${route.name}": weighted needs weights`);
    if (stickyBy !== undefined && (typeof stickyBy !== 'string' || stickyBy === '')) {
      invalid(`route "${route.name}": stickyBy must be a non empty context key`);
    }
    return { type, weights: resolveWeights(weights, route), stickyBy };
  }
  if (type === 'rank') return resolveRank(route, object, sources);
  if (typeof type === 'string' && type in SHORTHANDS) {
    return resolveRank(route, { weights: SHORTHANDS[type] }, sources);
  }
  return invalid(`route "${route.name}": unknown strategy "${String(type)}"`);
}

export function resolveLimits(route: RouteOptions, sources: Sources): ResolvedLimits {
  const limits = route.limits ?? {};
  if (typeof limits !== 'object' || limits === null) {
    invalid(`route "${route.name}": limits must be an object`);
  }
  const positive = (value: unknown, field: string): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      invalid(`route "${route.name}": limits.${field} must be a positive number`);
    }
    return value;
  };

  const latencyMs = positive(limits.latencyMs, 'latencyMs');
  const costUsd = positive(limits.costUsd, 'costUsd');
  const qualityFailureRate = positive(limits.qualityFailureRate, 'qualityFailureRate');
  if (qualityFailureRate !== undefined && qualityFailureRate > 1) {
    invalid(`route "${route.name}": limits.qualityFailureRate must be at most 1`);
  }
  if (latencyMs !== undefined) requireSource(route, 'limits.latencyMs', sources.stats, 'stats');
  if (costUsd !== undefined) requireSource(route, 'limits.costUsd', sources.cost, 'cost');
  if (qualityFailureRate !== undefined) {
    requireSource(
      route,
      'limits.qualityFailureRate',
      sources.statsFailureRate,
      'stats.failureRate',
    );
  }
  return { latencyMs, costUsd, qualityFailureRate };
}

export function sourcesOf(options: RouterOptions): Sources {
  return {
    stats: options.stats !== undefined,
    statsFailureRate: typeof options.stats?.failureRate === 'function',
    cost: options.cost !== undefined,
  };
}
