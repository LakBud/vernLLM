import type { LoggerOption, RankMetric, RouteWhen, TargetCapabilities } from './options.js';
import type { CustomMetric } from './signals.js';
import type { CostSource, HealthSource, StatsSource } from './sources.js';

/** Stands for every target a route's `targets` does not name, in declared order. */
export const ANY_TARGET = '*';

/** A strategy after validation, with weights as maps. */
export type ResolvedStrategy =
  | { type: 'ordered' }
  | { type: 'weighted'; weights: ReadonlyMap<string, number>; stickyBy: string | undefined }
  | { type: 'least-busy'; weights: ReadonlyMap<string, number> | undefined }
  | {
      type: 'rank';
      /** Only metrics with a weight above 0. */
      weights: ReadonlyMap<RankMetric, number>;
      q: number;
      tolerance: number;
      explore: number;
      custom: CustomMetric | undefined;
    };

/** Soft limits after validation. */
export interface ResolvedLimits {
  latencyMs: number | undefined;
  costUsd: number | undefined;
  qualityFailureRate: number | undefined;
}

/** A route after validation, with `targets` split into tiers. */
export interface ResolvedRoute {
  name: string;
  when: RouteWhen | undefined;
  /** Each tier holds names, and `ANY_TARGET` at most once across all tiers. Absent: every target. */
  tiers: readonly (readonly string[])[] | undefined;
  exclude: ReadonlySet<string>;
  strategy: ResolvedStrategy;
  /** Whether open breakers and exhausted limits move targets back on this route. */
  health: boolean;
  limits: ResolvedLimits;
}

/** A hold back rule after validation. */
export interface ResolvedHoldBack {
  event: string;
  when: readonly (readonly [string, string | number | boolean])[];
  holdMs: number;
}

export interface ResolvedConfig {
  routes: readonly ResolvedRoute[];
  capabilities: ReadonlyMap<string, TargetCapabilities>;
  apply: boolean;
  health: (() => HealthSource | undefined) | undefined;
  stats: StatsSource | undefined;
  cost: CostSource | undefined;
  statsTtlMs: number;
  slowStartMs: number;
  holdBack: readonly ResolvedHoldBack[];
  random: () => number;
  logger: LoggerOption | undefined;
}
