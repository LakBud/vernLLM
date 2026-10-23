import type { CustomMetric } from './signals.js';
import type { CostSource, HealthSource, StatsSource } from './sources.js';
import type { Logger, PreDispatchContext, WireCallRequest } from 'vern-llm';

/** Same shape as `VernLLMOptions.logger`. */
export type LoggerOption = Logger | 'silent';

/**
 * What a target can do, for requests it cannot serve. Only an explicit `false` or a known window
 * excludes a target; a target with no entry, or a field left out, is assumed capable.
 */
export interface TargetCapabilities {
  /** Largest input plus `max_tokens` the target accepts. */
  contextWindow?: number;
  /** `false` when the target cannot take tools. */
  tools?: boolean;
  /** `false` when the target cannot take a JSON schema `response_format`. */
  jsonSchema?: boolean;
  /** `false` when the target cannot take image content. */
  images?: boolean;
}

/** One value a `context` key can hold and a route can match on. */
export type ContextValue = string | number | boolean | null;

/** A value, or a list of values where any one matches. */
export type ContextMatch = ContextValue | readonly ContextValue[];

/** Conditions that must all hold for a route to match. */
export interface RouteConditions {
  /** Per key of the call's `context`: the value it must equal, or a list of allowed values. */
  context?: Readonly<Record<string, ContextMatch>>;
  /** Whether the request carries tools. */
  hasTools?: boolean;
  /** Whether the request asks for JSON output, `json_object` or a schema. */
  jsonOutput?: boolean;
  /** Estimated input tokens, at least this many. */
  minInputTokens?: number;
  /** Estimated input tokens, at most this many. */
  maxInputTokens?: number;
}

/** A synchronous test of the call. A throw fails open: the call runs with its declared order. */
export type RouteMatcher = (ctx: PreDispatchContext, request: Readonly<WireCallRequest>) => boolean;

/** Conditions that must all hold, or a function that decides. */
export type RouteWhen = RouteConditions | RouteMatcher;

/**
 * Which targets a route may use, and in what groups.
 *
 * - `['a', 'b']`: only these, one tier, in this order unless the strategy picks otherwise
 * - `[['a', 'b'], ['c']]`: tiers, each tried before the next
 * - `'*'`: every remaining target, in declared order. Mixed in as `[['a'], '*']`
 */
export type RouteTargets = readonly (string | readonly string[])[];

/** Keeps the order of the route's `targets`, else the declared order. */
export interface OrderedStrategy {
  type: 'ordered';
}

/**
 * A weighted random pick goes first and the rest follow by weight. A target missing from
 * `weights` counts as `1`, and one with `0` is picked first only when nothing else is left.
 */
export interface WeightedStrategy {
  type: 'weighted';
  weights: Readonly<Record<string, number>>;
  /**
   * A context key whose value is hashed instead of drawing at random, so one user keeps the same
   * first target. That also keeps the provider's prompt cache warm for that user. A call without
   * the key draws at random.
   */
  stickyBy?: string;
}

/**
 * For several deployments of one model. Two targets are sampled, by `weights` when given, and the
 * one with fewer attempts in flight, divided by its weight, goes first. The rest follow by their
 * in flight count.
 */
export interface LeastBusyStrategy {
  type: 'least-busy';
  weights?: Readonly<Record<string, number>>;
}

/** The things `rank` can weigh. Lower is better for every one of them. */
export type RankMetric =
  | 'latency'
  | 'predictedLatency'
  | 'cost'
  | 'effectiveCost'
  | 'quality'
  | 'custom';

/**
 * Scores every target on weighted metrics, each as how many times worse than the best target
 * (log scale, so units combine and an outlier only hurts itself), then picks first from the
 * targets within `tolerance` of the best, weighted by closeness.
 *
 * `'latency'`, `'cost'` and `'balanced'` are shorthands: one weight of 1 on latency or cost, and
 * 0.5 on each for balanced.
 */
export interface RankStrategy {
  type: 'rank';
  weights: Readonly<Partial<Record<RankMetric, number>>>;
  /** Quantile of `attemptMs` that `latency` and `predictedLatency` use. Default `0.95`. */
  q?: number;
  /** How close to the best a target must be to share first place, as a ratio. Default `0.2`. */
  tolerance?: number;
  /** Chance that a random usable target goes first, so every target keeps being sampled. Default `0.05`. */
  explore?: number;
  /** Required when `weights.custom` is set. */
  custom?: CustomMetric;
}

/** Soft limits: a target over one moves back, it is never dropped. */
export interface RouteLimits {
  /** p95 of `attemptMs`. Needs `stats`. */
  latencyMs?: number;
  /** What the request could cost, in USD. Needs `cost`. */
  costUsd?: number;
  /** Quality failure share, in `(0, 1]`. Needs `stats.failureRate`. */
  qualityFailureRate?: number;
}

/** How a route orders its targets. The strategy runs inside each tier. */
export type StrategyOption =
  | 'ordered'
  | 'least-busy'
  | 'latency'
  | 'cost'
  | 'balanced'
  | OrderedStrategy
  | WeightedStrategy
  | LeastBusyStrategy
  | RankStrategy;

export interface RouteOptions {
  /** Unique. Appears in events and is what `routerRouteKey` forces. */
  name: string;
  /**
   * When this route applies. The first route whose `when` matches wins. Omitted: matches
   * everything, allowed only on the last route.
   */
  when?: RouteWhen;
  /** Which targets, in what order and tiers. Omitted: every target the call can use. */
  targets?: RouteTargets;
  /** Targets to drop, for "everything except" without listing the rest. */
  exclude?: readonly string[];
  /** Default `ordered`. */
  strategy?: StrategyOption;
  /**
   * `false` keeps targets with an open breaker or an exhausted limit in place for this route.
   * Rate limit warming still applies. Default `true`.
   */
  health?: boolean;
  /** Soft limits: a target over one moves back behind those within. */
  limits?: RouteLimits;
}

export interface RouterOptions {
  /** The first route that matches a call decides its order. None matching keeps the order as it is. */
  routes?: readonly RouteOptions[];
  /** What each target can serve, by target name. Requests a target cannot serve skip it. */
  capabilities?: Readonly<Record<string, TargetCapabilities>>;
  /**
   * Default `true`. `false` is shadow mode: every decision is computed and emitted, and every
   * call keeps the order it would have had without a router.
   */
  apply?: boolean;
  /**
   * Where breaker states and rate limits are read. A getter, because the middleware is built
   * before its `VernLLM`: `health: () => llm`. Without it no target is ever demoted for health.
   */
  health?: () => HealthSource | undefined;
  /**
   * Milliseconds a target ramps back to full traffic after its breaker closes. Default `30000`,
   * `0` turns warming off.
   */
  slowStartMs?: number;
  /** Replaces `Math.random`, for tests. Returns a number in `[0, 1)`. */
  random?: () => number;
  /** Rolling stats for `latency`, `predictedLatency`, `quality` and limits. `logger.stats` fits. */
  stats?: StatsSource;
  /** Prices a request on a target for `cost`, `effectiveCost` and `limits.costUsd`. `usage.costFor` fits. */
  cost?: CostSource;
  /** Milliseconds a stats read is reused. Default `1000`, `0` reads every time. */
  statsTtlMs?: number;
  /** Where the router reports its own failures and configuration warnings. */
  logger?: LoggerOption;
}
