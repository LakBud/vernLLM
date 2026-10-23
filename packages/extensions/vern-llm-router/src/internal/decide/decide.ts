import {
  ANY_TARGET,
  type Decision,
  type ExcludedTarget,
  type ResolvedRoute,
  type TargetCapabilities,
} from '../../types/index.js';
import { demote } from './demote.utils.js';
import { overLimits } from './limits.utils.js';
import { HEALTHY, type Signals } from './signals.js';
import { orderTier } from './strategies.utils.js';

import type { RequestFacts } from '../match/requestFacts.utils.js';

export interface DecideInput {
  /** Target names in the order so far, as the core hands them over. */
  targets: readonly string[];
  /** The matched route, if any. */
  route: ResolvedRoute | undefined;
  capabilities: ReadonlyMap<string, TargetCapabilities>;
  facts: RequestFacts;
  /** What is known per target name. A target without an entry is assumed healthy. */
  signals?: ReadonlyMap<string, Signals>;
  /** Random draws, for warming and the strategies. */
  rng?: () => number;
  /** A number in `[0, 1)` from the call's `stickyBy` value, standing in for a draw. */
  stickyUnit?: number;
  /** The time of the decision, in epoch ms, for the deadline. */
  now?: number;
  /** When the call's deadline runs out, in epoch ms. */
  deadlineAt?: number;
}

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
function applyRoute(
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
 * Pure and synchronous: the order for one call from facts already in hand.
 *
 * A route that leaves nothing returns an empty order, which the core rejects with
 * `no_eligible_targets`: an honest configuration error. The capability filter never empties the
 * list on its own; when nothing is known to be capable, every routed target stays.
 */
export function decide(input: DecideInput): Decision {
  const { targets, route, capabilities, facts } = input;
  const signals = input.signals ?? new Map<string, Signals>();
  const rng = input.rng ?? Math.random;
  const excluded: ExcludedTarget[] = [];

  const routed = route ? applyRoute(targets, route, excluded) : [[...targets]];
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

  const strategy = route?.strategy ?? { type: 'ordered' as const };
  const over = overLimits(tiers.flat(), signals, route?.limits, input.now, input.deadlineAt);
  const usable = (name: string): boolean => {
    const signal = signals.get(name) ?? HEALTHY;
    return signal.circuit !== 'open' && !signal.limited && !over.has(name);
  };

  const explored = new Set<string>();
  const scores: Record<string, number> = {};
  const ordered = tiers.flatMap((names) => {
    const result = orderTier({
      names,
      strategy,
      signals,
      rng,
      stickyUnit: input.stickyUnit,
      usable,
    });
    if (result.explored !== undefined) explored.add(result.explored);
    for (const [name, score] of result.scores ?? []) scores[name] = Math.round(score * 100) / 100;
    return result.order;
  });

  const { order, demoted } = demote({
    order: ordered,
    signals,
    over,
    health: route?.health ?? true,
    rng,
  });

  return {
    ...(route ? { route: route.name } : {}),
    strategy: strategy.type,
    order,
    excluded,
    demoted,
    ...(Object.keys(scores).length > 0 ? { scores } : {}),
    explored: order[0] !== undefined && explored.has(order[0]),
  };
}

/** The decision for a call whose caller chose the order by hand: left exactly as given. */
export function pinnedDecision(targets: readonly string[]): Decision {
  return { strategy: 'pinned', order: [...targets], excluded: [], demoted: [], explored: false };
}

/** Names a route lists that the call does not have, for a one time warning. */
export function unknownTargetsOf(route: ResolvedRoute, targets: readonly string[]): string[] {
  const known = new Set(targets);
  return [...(route.tiers?.flat() ?? []), ...route.exclude].filter(
    (name) => name !== ANY_TARGET && !known.has(name),
  );
}
