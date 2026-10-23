import { ANY_TARGET, type ResolvedRoute, type RouteOptions } from '../../types/index.js';
import { resolveLimits, resolveStrategy, type Sources } from './normalizeStrategy.utils.js';
import { invalid } from './validate.utils.js';

function resolveTiers(route: RouteOptions): ResolvedRoute['tiers'] {
  const { targets } = route;
  if (targets === undefined) return undefined;
  if (!Array.isArray(targets) || targets.length === 0) {
    invalid(`route "${route.name}": targets must be a non empty list`);
  }

  // Consecutive bare names share one tier, so a strategy has something to choose between. A nested
  // list is a tier of its own, and `*` is always alone in its tier.
  const seen = new Set<string>();
  const tiers: string[][] = [];
  let open: string[] | undefined;
  const add = (name: unknown): string => {
    if (typeof name !== 'string' || name === '') {
      invalid(`route "${route.name}": target names must be non empty strings`);
    }
    if (seen.has(name)) invalid(`route "${route.name}": target "${name}" is listed twice`);
    seen.add(name);
    return name;
  };

  for (const entry of targets) {
    if (Array.isArray(entry)) {
      if (entry.length === 0) invalid(`route "${route.name}": a tier cannot be empty`);
      tiers.push(entry.map(add));
      open = undefined;
    } else if (entry === ANY_TARGET) {
      tiers.push([add(entry)]);
      open = undefined;
    } else {
      if (!open) tiers.push((open = []));
      open.push(add(entry));
    }
  }
  return tiers;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A function is trusted as is; a conditions object must have the shapes the matcher compares. */
function checkWhen(route: RouteOptions): void {
  const when: unknown = route.when;
  if (when === undefined || typeof when === 'function') return;
  const label = `route "${route.name}": when`;
  if (!isPlainObject(when)) invalid(`${label} must be a function or a conditions object`);

  for (const key of ['hasTools', 'jsonOutput']) {
    if (when[key] !== undefined && typeof when[key] !== 'boolean') {
      invalid(`${label}.${key} must be a boolean`);
    }
  }
  for (const key of ['minInputTokens', 'maxInputTokens']) {
    const value = when[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      invalid(`${label}.${key} must be a finite number`);
    }
  }
  if (when.context !== undefined && !isPlainObject(when.context)) {
    invalid(`${label}.context must be an object`);
  }
}

function resolveRoute(route: RouteOptions, isLast: boolean, sources: Sources): ResolvedRoute {
  if (typeof route?.name !== 'string' || route.name === '') {
    invalid('every route needs a non empty name');
  }
  if (route.when === undefined && !isLast) {
    invalid(`route "${route.name}": only the last route can omit "when"`);
  }
  checkWhen(route);
  const strategy = resolveStrategy(route, sources);
  const limits = resolveLimits(route, sources);
  if (route.health !== undefined && typeof route.health !== 'boolean') {
    invalid(`route "${route.name}": health must be a boolean`);
  }
  const exclude = route.exclude ?? [];
  if (!Array.isArray(exclude) || exclude.some((name) => typeof name !== 'string')) {
    invalid(`route "${route.name}": exclude must be a list of target names`);
  }
  const tiers = resolveTiers(route);
  if (tiers?.some((tier) => tier.includes(ANY_TARGET) && tier.length > 1)) {
    invalid(`route "${route.name}": "${ANY_TARGET}" must stand alone in its tier`);
  }
  // Only detectable up front when every target is named: `*` could stand for others.
  const named = tiers?.flat();
  if (named && !named.includes(ANY_TARGET) && named.every((name) => exclude.includes(name))) {
    invalid(`route "${route.name}": exclude removes every target the route lists`);
  }

  return {
    name: route.name,
    when: route.when,
    tiers,
    exclude: new Set(exclude),
    strategy,
    health: route.health !== false,
    limits,
  };
}

/** Every route validated and resolved, with names unique and only the last without `when`. */
export function resolveRoutes(routes: readonly RouteOptions[], sources: Sources): ResolvedRoute[] {
  const names = new Set<string>();
  return routes.map((route, index) => {
    const resolved = resolveRoute(route, index === routes.length - 1, sources);
    if (names.has(resolved.name)) invalid(`route name "${resolved.name}" is used twice`);
    names.add(resolved.name);
    return resolved;
  });
}
