import { resolveRoutes } from './normalizeRoutes.utils.js';
import { sourcesOf } from './normalizeStrategy.utils.js';
import { invalid } from './validate.utils.js';

import type { ResolvedConfig, RouterOptions, TargetCapabilities } from '../../types/index.js';

function resolveCapabilities(
  capabilities: RouterOptions['capabilities'],
): Map<string, TargetCapabilities> {
  const resolved = new Map<string, TargetCapabilities>();
  for (const [name, value] of Object.entries(capabilities ?? {})) {
    const window = value?.contextWindow;
    if (window !== undefined && (!Number.isFinite(window) || window <= 0)) {
      invalid(`capabilities "${name}": contextWindow must be a positive number`);
    }
    resolved.set(name, { ...value });
  }
  return resolved;
}

/** Validates the options once, so a mistake fails at construction instead of mid call. */
export function normalizeOptions(options: RouterOptions = {}): ResolvedConfig {
  if (options.apply !== undefined && typeof options.apply !== 'boolean') {
    invalid('apply must be a boolean');
  }
  if (options.health !== undefined && typeof options.health !== 'function') {
    invalid('health must be a function returning the VernLLM instance');
  }
  if (options.random !== undefined && typeof options.random !== 'function') {
    invalid('random must be a function');
  }
  const slowStartMs = options.slowStartMs ?? 30_000;
  if (!Number.isFinite(slowStartMs) || slowStartMs < 0) {
    invalid('slowStartMs must be a number of at least 0');
  }
  if (options.stats !== undefined && typeof options.stats?.quantile !== 'function') {
    invalid('stats must have a quantile function');
  }
  if (options.cost !== undefined && typeof options.cost !== 'function') {
    invalid('cost must be a function');
  }
  const statsTtlMs = options.statsTtlMs ?? 1_000;
  if (!Number.isFinite(statsTtlMs) || statsTtlMs < 0) {
    invalid('statsTtlMs must be a number of at least 0');
  }
  const sources = sourcesOf(options);

  return {
    routes: resolveRoutes(options.routes ?? [], sources),
    capabilities: resolveCapabilities(options.capabilities),
    apply: options.apply ?? true,
    health: options.health,
    stats: options.stats,
    cost: options.cost,
    statsTtlMs,
    slowStartMs,
    random: options.random ?? Math.random,
    logger: options.logger,
  };
}
