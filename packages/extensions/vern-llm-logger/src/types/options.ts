import type { LoggerOption } from '../internal/guard.utils.js';
import type { CallLogRecord, JsonValue, SummaryEntry } from './entries.js';
import type { LogLevel, LogSink } from './sink.js';
import type { PreDispatchContext } from 'vern-llm';

/** Yields a series dimension for a record, or `undefined` to leave it out. */
export type DimensionExtractor = (record: Readonly<CallLogRecord>) => string | undefined;

/** Adds fields to a call's record, for example `otelLogFields`. */
export type Enricher = (ctx: PreDispatchContext) => Record<string, JsonValue> | undefined;

export interface CustomEventsOptions {
  /** Keep the first party event namespaces. Default `true`. */
  defaults?: boolean;
  /** Plain names or `prefix.*` patterns. */
  names?: string[];
}

export interface LoggerMiddlewareOptions {
  /** Default `jsonSink()`. */
  sink?: LogSink;
  /** The lowest level that reaches the sink. Default `'info'`. */
  level?: LogLevel;
  /** Quantiles to report, ascending, each in (0, 1). Default `[0.5, 0.9, 0.95, 0.99]`. */
  percentiles?: number[];
  /** Rolling window for the percentiles. Default one minute in six slots. */
  window?: { durationMs?: number; slots?: number };
  /** Mark slow calls. Off unless `thresholdMs` or `aboveLivePercentile` is set. */
  slowCall?: { thresholdMs?: number; aboveLivePercentile?: number };
  /** Samples a series needs before its percentiles are reported or trusted. Default `20`. */
  minSamples?: number;
  /** Cap on distinct dimension sets. Overflow goes to one shared set. Default `200`. */
  maxSeries?: number;
  /** Fraction of plain successes kept. Everything else is always kept. Default `1`. */
  sample?: { success?: number };
  /** Group repeated errors into one entry per window. Default `true`. */
  errorGrouping?: boolean;
  /** Allowlisted keys copied from the call's `context` into the record. */
  context?: string[];
  /** Custom events to keep. A list adds to the defaults; an object can switch them off. */
  customEvents?: string[] | CustomEventsOptions;
  /** Split percentiles by any string a record yields. */
  dimensions?: Record<string, DimensionExtractor>;
  /** One function or a list, merged left to right into `fields`. */
  enrich?: Enricher | Enricher[];
  /** Periodic summary of every series. Default off. */
  summary?: { everyMs?: number; onSummary?: (summary: readonly SummaryEntry[]) => void };
  /** Where the package's own diagnostics go. Default is a console logger. */
  logger?: LoggerOption;
  /** Label in log lines. Default `'logger'`. */
  name?: string;
}
