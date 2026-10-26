import type {
  AdaptOptions,
  CacheAwareOptions,
  DelayFunction,
  LoggerOption,
  StatsSource,
  TargetsFunction,
  WhenFunction,
} from './options.js';

/** The delay after validation: one of three shapes, with every default filled in. */
export type ResolvedDelay =
  | { kind: 'fixed'; ms: number }
  | { kind: 'function'; fn: DelayFunction }
  | { kind: 'quantile'; quantile: number; minMs: number; fallbackMs: number | undefined };

/** The cache awareness with every default filled in. */
export type ResolvedCacheAware = Required<CacheAwareOptions>;

/** The win rate adaptation with every default filled in. */
export type ResolvedAdapt = Required<AdaptOptions>;

export interface ResolvedConfig {
  stats: StatsSource | undefined;
  delay: ResolvedDelay;
  budget: { ratio: number; burst: number };
  maxHedges: number;
  adapt: ResolvedAdapt | undefined;
  cacheAware: ResolvedCacheAware | undefined;
  targets: TargetsFunction;
  when: WhenFunction;
  statsTtlMs: number;
  logger: LoggerOption | undefined;
}
