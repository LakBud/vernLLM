export type MetricName =
  | 'durationMs'
  | 'ttftMs'
  | 'attemptMs'
  | 'queueWaitMs'
  | 'outputTokensPerSec'
  /** Completion tokens of each successful call. */
  | 'outputTokens';

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
  /**
   * Share of responded attempts whose answer was rejected as unusable, over the window, or
   * `undefined` below `minSamples` responded attempts. `quality` counts invalid structured
   * output, unparseable or truncated replies, empty replies, soft failures and tool contract
   * breaks. Timeouts, network errors, 429s and 5xx are about availability and never count, and
   * neither do caller errors, budget or policy rejections and aborts.
   *
   * Counted per attempt and under the provider that attempt went to, so a call rescued by a
   * fallback still counts its failed attempts against the target that produced them. `filter`
   * takes the same dimensions as `quantile`.
   */
  failureRate(filter: StatsFilter, kind: 'quality'): number | undefined;
  reset(): void;
}
