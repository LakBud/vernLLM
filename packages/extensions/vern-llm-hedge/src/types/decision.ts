/** Why a call was not hedged at all. */
export type SkipReason =
  | 'unavailable'
  | 'no_target'
  | 'not_allowed'
  | 'paused'
  | 'cached'
  | 'no_data'
  | 'deadline';

/**
 * How a call went.
 *
 * - `won`: a hedge was sent and its answer was kept.
 * - `lost`: a hedge was sent and the main chain's outcome was kept, an error included.
 * - `not_needed`: the main chain answered before the delay.
 * - `failed`: the main chain failed before the delay, so there was nothing to hedge.
 * - `aborted`: the caller cancelled the call before the delay passed.
 * - `budget`: the delay passed and the budget had no token.
 * - Any {@link SkipReason}: the call was never eligible.
 */
export type HedgeOutcome =
  | 'won'
  | 'lost'
  | 'not_needed'
  | 'failed'
  | 'aborted'
  | 'budget'
  | SkipReason;

/**
 * The custom event `hedge.decision`, emitted once per call when the hedge settles. Names and
 * numbers only, so it is safe on spans and in logs.
 */
export interface HedgeDecisionEvent {
  v: 1;
  outcome: HedgeOutcome;
  /** The delay the call waited for, when one was computed. */
  delayMs?: number;
  /** Where the hedge went first, when one was sent. */
  target?: string;
  /** How many hedges were sent, only when more than one. */
  hedges?: number;
  /** Which target's answer was kept, only when more than one hedge was sent and one won. */
  winner?: string;
  /** From the start of the call to the kept answer, when a hedge was sent and one answered. */
  ms?: number;
}

/**
 * The custom event `hedge.adapt`, emitted when the win rate changes what the hedge does for a
 * first target.
 *
 * - `raise_quantile`: hedges rarely won, so the target now waits for `quantile`.
 * - `pause`: hedges still rarely won at the highest quantile, so the target is not hedged for a while.
 * - `slow`: hedges often won, so the first target itself is slow. Reported again every `minHedges`
 *   hedged calls while the rate stays high.
 */
export interface AdaptEvent {
  action: 'raise_quantile' | 'pause' | 'slow';
  /** The first target. */
  target: string;
  /** Hedges that won over the hedged calls judged, from 0 to 1. */
  winRate: number;
  /** How many hedged calls it was judged over. */
  hedges: number;
  /** The new quantile, for `raise_quantile`. */
  quantile?: number;
}
