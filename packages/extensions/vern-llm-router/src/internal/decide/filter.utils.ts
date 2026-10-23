import {
  ANY_TARGET,
  type ExcludedTarget,
  type ResolvedRoute,
  type TargetCapabilities,
} from '../../types/index.js';

import type { RequestFacts } from '../match/requestFacts.utils.js';

/** Whether `target` cannot serve this request, going only by what was declared. */
function lacksCapability(capability: TargetCapabilities | undefined, facts: RequestFacts): boolean {
  if (!capability) return false;
  if (capability.tools === false && facts.hasTools) return true;
  if (capability.jsonSchema === false && facts.jsonSchema) return true;
  if (capability.images === false && facts.images) return true;
  if (
    capability.contextWindow !== undefined &&
    facts.inputTokens + facts.maxTokens > capability.contextWindow
  ) {
    return true;
  }
  return false;
}

/**
 * Applies a route's tiers and `exclude`: the kept names of each tier, in route order, with `*`
 * standing for every target the route does not name. Empty tiers are dropped.
 */
export function applyRoute(
  targets: readonly string[],
  route: ResolvedRoute,
  excluded: ExcludedTarget[],
): string[][] {
  const available = new Set(targets);
  const named = new Set(route.tiers?.flat() ?? []);

  const tiers: string[][] =
    route.tiers === undefined
      ? [[...targets]]
      : route.tiers.map((tier) =>
          tier.flatMap((name) =>
            name === ANY_TARGET
              ? targets.filter((target) => !named.has(target))
              : available.has(name)
                ? [name]
                : [],
          ),
        );

  const kept = tiers.map((tier) => tier.filter((name) => !route.exclude.has(name)));
  const keptSet = new Set(kept.flat());
  // Whatever did not make it, whether excluded or never named, is out by the route's choice.
  for (const target of targets) {
    if (!keptSet.has(target)) excluded.push({ target, reason: 'route' });
  }
  return kept.filter((tier) => tier.length > 0);
}

/**
 * Drops targets that declared they cannot serve this request, tier by tier. Never empties the
 * list on its own: when nothing is known to be capable, every routed target stays.
 */
export function applyCapabilities(
  routed: string[][],
  capabilities: ReadonlyMap<string, TargetCapabilities>,
  facts: RequestFacts,
  excluded: ExcludedTarget[],
): string[][] {
  const capable = routed
    .map((tier) => tier.filter((name) => !lacksCapability(capabilities.get(name), facts)))
    .filter((tier) => tier.length > 0);
  const tiers = capable.length > 0 || routed.length === 0 ? capable : routed;
  if (tiers !== routed) {
    const kept = new Set(tiers.flat());
    for (const name of routed.flat()) {
      if (!kept.has(name)) excluded.push({ target: name, reason: 'capability' });
    }
  }
  return tiers;
}
