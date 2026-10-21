export type MetricName =
  | 'durationMs'
  | 'ttftMs'
  | 'attemptMs'
  | 'queueWaitMs'
  | 'outputTokensPerSec';

/** One rolling histogram for one metric and one set of dimension values. */
export interface SeriesSnapshot {
  metric: MetricName;
  /** The built in dimensions (`provider`, `model`, `streaming`) plus any user dimensions. */
  dimensions: Record<string, string>;
  count: number;
  /** Quantile values keyed by the quantile as a string, for example `"0.99"`. */
  quantiles: Record<string, number>;
  errors: number;
  rejections: number;
  aborts: number;
  cacheHits: number;
}

/** Dimension values to match, such as `{ provider: 'primary' }`. Empty means all calls. */
export type StatsFilter = Readonly<Record<string, string>>;

export interface StatsSnapshot {
  /** The rolling window the series cover. */
  windowMs: number;
  series: SeriesSnapshot[];
}

/** Reads the rolling stats. Meant for dashboards and health endpoints. */
export interface StatsApi {
  snapshot(): StatsSnapshot;
  /** The value at `q` over the window, or `undefined` below `minSamples`. */
  quantile(filter: StatsFilter, q: number, metric?: MetricName): number | undefined;
  reset(): void;
}
