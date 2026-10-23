/** Why a target was left out of the order. */
export type ExcludedReason = 'route' | 'capability';

export interface ExcludedTarget {
  target: string;
  reason: ExcludedReason;
}

/** Why a target was moved back. Set by the steps that demote; empty until they run. */
export type DemotedReason = 'open' | 'limited' | 'over_limit' | 'over_deadline' | 'warming';

export interface DemotedTarget {
  target: string;
  reason: DemotedReason;
}

/** How the order was reached. `pinned` means the caller chose it and the router left it alone. */
export type DecisionStrategy = 'ordered' | 'weighted' | 'least-busy' | 'rank' | 'pinned';

/** The order for one call, and why. */
export interface Decision {
  /** The route that matched. Absent when none did, or when the caller pinned the order. */
  route?: string;
  strategy: DecisionStrategy;
  /** Target names, first to try first. */
  order: string[];
  excluded: ExcludedTarget[];
  demoted: DemotedTarget[];
  /** `rank` only: each target's score, lower is better, rounded to two decimals. */
  scores?: Record<string, number>;
  /** Whether the first target is an exploration pick rather than the best ranked. */
  explored: boolean;
}

/**
 * The custom event `router.decision`, emitted once per call after the call's `next()` settles.
 * Names and numbers only, so it is safe on spans and in logs.
 */
export interface RouterDecisionEvent extends Decision {
  v: 1;
  /**
   * Whether this order is the one the call ran with. `false` in shadow mode, for a pinned call
   * (the router left the order alone), and for a cache hit or join, which never used it.
   */
  applied: boolean;
}
