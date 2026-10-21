import type { LoggerOption } from '../internal/guard.utils.js';
import type { SummaryEntry } from './entries.js';
import type { DimensionExtractor, Enricher } from './options.js';
import type { LogLevel, LogSink } from './sink.js';

/** Every option validated and defaulted once, so no other file repeats a default. */
export interface ResolvedConfig {
  readonly sink: LogSink;
  readonly level: LogLevel;
  readonly percentiles: readonly number[];
  readonly window: { readonly durationMs: number; readonly slots: number };
  readonly slowCall: {
    readonly thresholdMs: number | undefined;
    readonly aboveLivePercentile: number | undefined;
  };
  readonly minSamples: number;
  readonly maxSeries: number;
  readonly sampleSuccess: number;
  readonly errorGrouping: boolean;
  readonly context: readonly string[];
  /** True when the event name is one the record should keep. Compiled once. */
  readonly keepCustomEvent: (name: string) => boolean;
  readonly dimensions: ReadonlyMap<string, DimensionExtractor>;
  readonly enrich: readonly Enricher[];
  readonly summary:
    | {
        readonly everyMs: number;
        readonly onSummary: ((summary: readonly SummaryEntry[]) => void) | undefined;
      }
    | undefined;
  readonly logger: LoggerOption | undefined;
  readonly name: string;
}
