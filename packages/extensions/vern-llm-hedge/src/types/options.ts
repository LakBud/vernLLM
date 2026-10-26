import type { Logger, PreDispatchContext, WireCallRequest } from 'vern-llm';

/** Same shape as `VernLLMOptions.logger`. */
export type LoggerOption = Logger | 'silent';

/**
 * Rolling stats, such as `logger.stats` from `vern-llm-logger`. The logger matches this
 * structurally. The hedge asks only for the `attemptMs` quantile.
 */
export interface StatsSource {
  quantile(
    filter: Readonly<Record<string, string>>,
    q: number,
    metric?: string,
  ): number | undefined;
}

/** A delay learned from the first target's own recent latency. */
export interface DelayQuantile {
  /** The quantile of `attemptMs` to wait for, strictly between 0 and 1. Typically `0.95`. */
  quantile: number;
  /** The delay is never shorter than this. Default `0`. */
  minMs?: number;
  /** Used while the logger has too few samples. Without it, a call with no data is not hedged. */
  fallbackMs?: number;
}

/**
 * Your own delay for this call, in milliseconds. `undefined` skips the hedge for this call. A
 * result that is not a positive, finite number counts as `undefined`.
 */
export type DelayFunction = (
  ctx: PreDispatchContext,
  request: Readonly<WireCallRequest>,
) => number | undefined;

/** A quantile of the first target's `attemptMs`, a fixed number of milliseconds, or a function. */
export type DelayOption = DelayQuantile | number | DelayFunction;

/**
 * Reads how often each first target's hedges win, over its last `window` hedged calls, once it
 * has at least `minHedges`.
 */
export interface AdaptOptions {
  /** How many recent hedged calls to judge by. Default `50`. */
  window?: number;
  /** The fewest hedged calls to judge by, at most `window`. Default `20`. */
  minHedges?: number;
  /**
   * Below this win rate the hedge is too early for that target: its quantile is raised by
   * `quantileStep` up to `maxQuantile`, and once it cannot go higher the target is not hedged for
   * `pauseMs`. Default `0.1`.
   */
  lowWinRate?: number;
  /**
   * Above this win rate the first target is the problem, which is reported as a `hedge.adapt`
   * event with action `slow`, and again every `minHedges` hedged calls while it stays above.
   * Default `0.5`, and above `lowWinRate`.
   */
  highWinRate?: number;
  /** How much each raise adds to the quantile. Default `0.02`. */
  quantileStep?: number;
  /** The highest quantile a raise reaches, below 1. Default `0.99`. */
  maxQuantile?: number;
  /** How long a paused target is not hedged, in milliseconds. Default `300000`. */
  pauseMs?: number;
}

/**
 * Notices when the first target has recently served a prompt's prefix from its provider cache,
 * since a hedge to another provider starts cold and pays full price for that prefix. It learns
 * this from the `cacheReadTokens` the target reported on earlier calls, in this process. It is a
 * heuristic: the prefix is the role and text of the first `prefixChars` characters, so the model,
 * tools, other parameters and images are not part of it, and the usage event's `provider` is taken
 * to be the target's name.
 */
export interface CacheAwareOptions {
  /** How long a target is assumed to keep a prefix cached, in milliseconds. Default `300000`. */
  ttlMs?: number;
  /** How many leading characters of the prompt identify its prefix. Default `2000`. */
  prefixChars?: number;
  /**
   * `'delay'` (default) waits `delayFactor` times as long before hedging such a call. `'skip'`
   * does not hedge it, with outcome `cached`.
   */
  action?: 'delay' | 'skip';
  /** How much longer `'delay'` waits, above 1. Default `2`. */
  delayFactor?: number;
}

/** Caps hedges at about `ratio` of eligible calls, whatever the latency does. */
export interface BudgetOptions {
  /** Tokens each eligible call adds, above 0 and at most 1. Default `0.05`. */
  ratio?: number;
  /** The most tokens held, at least 1. Default `10`. */
  burst?: number;
}

/**
 * Where the hedge may go, in order. Names the call's order does not contain are ignored, and an
 * empty result skips the hedge. `nextTargets` is the default.
 */
export type TargetsFunction = (
  ctx: PreDispatchContext,
  request: Readonly<WireCallRequest>,
) => readonly string[];

/** Whether this call may be hedged at all. A throw counts as `false`. */
export type WhenFunction = (ctx: PreDispatchContext) => boolean;

export interface HedgeOptions {
  /**
   * Rolling stats with `quantile(filter, q, metric)`; `logger.stats` fits. Required unless `delay`
   * is a number or a function.
   */
  stats?: StatsSource;
  /** Default `{ quantile: 0.95 }`. */
  delay?: DelayOption;
  /** Default `{ ratio: 0.05, burst: 10 }`. The bucket starts empty. */
  budget?: BudgetOptions;
  /**
   * The most hedges one call may send, from 1 to 4, which is the core's limit on reruns. Each
   * waits one more delay than the one before, goes to the next name in `targets`, and takes a
   * budget token. No more are sent once the main chain has settled or any chain has answered.
   * Default `1`.
   */
  maxHedges?: number;
  /**
   * Adjusts each first target's delay by how often its hedges win. `true` takes the defaults of
   * {@link AdaptOptions}. Off by default. The tracking is in this process only.
   */
  adapt?: boolean | AdaptOptions;
  /**
   * Waits longer, or does not hedge, when the first target has this prompt's prefix in its
   * provider cache. `true` takes the defaults of {@link CacheAwareOptions}. Off by default.
   */
  cacheAware?: boolean | CacheAwareOptions;
  /** Default `nextTargets`: the call's targets after the first. */
  targets?: TargetsFunction;
  /** Default: every call. */
  when?: WhenFunction;
  /** How long a stats read is reused, in milliseconds. Default `1000`. */
  statsTtlMs?: number;
  /** Where the hedge reports its own failures and configuration warnings. */
  logger?: LoggerOption;
}
