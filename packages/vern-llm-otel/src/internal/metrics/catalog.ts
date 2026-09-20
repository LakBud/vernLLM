import {
  ATTEMPT_COUNT_BUCKETS,
  DURATION_BUCKETS,
  METRIC,
  TOKEN_USAGE_BUCKETS,
  UNIT_ATTEMPT,
  UNIT_SECOND,
  UNIT_TOKEN,
} from '../semconv.js';

export type MetricKey = keyof typeof METRIC;

interface SpecBase {
  name: string;
  unit: string;
  description: string;
  /** Part of the GenAI conventions, so skipped when `genAiConventions` is off. */
  genAi: boolean;
}

/** A histogram always carries bucket advice, so there is no default bucketing to fall back to. */
export type InstrumentSpec =
  | (SpecBase & { kind: 'histogram'; buckets: readonly number[] })
  | (SpecBase & { kind: 'counter' });

/** Every instrument, declared once as data so recording needs no per instrument code. */
export const CATALOG: Readonly<Record<MetricKey, InstrumentSpec>> = {
  tokenUsage: {
    name: METRIC.tokenUsage,
    kind: 'histogram',
    unit: UNIT_TOKEN,
    description: 'Number of input and output tokens used',
    buckets: TOKEN_USAGE_BUCKETS,
    genAi: true,
  },
  operationDuration: {
    name: METRIC.operationDuration,
    kind: 'histogram',
    unit: UNIT_SECOND,
    description: 'GenAI operation duration, excluding local rate limit waiting',
    buckets: DURATION_BUCKETS,
    genAi: true,
  },
  timeToFirstChunk: {
    name: METRIC.timeToFirstChunk,
    kind: 'histogram',
    unit: UNIT_SECOND,
    description: 'Time to receive the first chunk of a streaming response',
    buckets: DURATION_BUCKETS,
    genAi: true,
  },
  callDuration: {
    name: METRIC.callDuration,
    kind: 'histogram',
    unit: UNIT_SECOND,
    description: 'Duration of one logical call, including retries and fallbacks',
    buckets: DURATION_BUCKETS,
    genAi: false,
  },
  callAttempts: {
    name: METRIC.callAttempts,
    kind: 'histogram',
    unit: UNIT_ATTEMPT,
    description: 'Attempts made by one logical call across all targets',
    buckets: ATTEMPT_COUNT_BUCKETS,
    genAi: false,
  },
  retryCount: {
    name: METRIC.retryCount,
    kind: 'counter',
    unit: '{retry}',
    description: 'Retries scheduled after a failed attempt',
    genAi: false,
  },
  retryDelay: {
    name: METRIC.retryDelay,
    kind: 'histogram',
    unit: UNIT_SECOND,
    description: 'Delay before a scheduled retry',
    buckets: DURATION_BUCKETS,
    genAi: false,
  },
  fallbackCount: {
    name: METRIC.fallbackCount,
    kind: 'counter',
    unit: '{fallback}',
    description: 'Moves from one target to the next',
    genAi: false,
  },
  rateLimitWait: {
    name: METRIC.rateLimitWait,
    kind: 'histogram',
    unit: UNIT_SECOND,
    description: 'Time spent waiting for local rate limit capacity',
    buckets: DURATION_BUCKETS,
    genAi: false,
  },
  circuitTransitions: {
    name: METRIC.circuitTransitions,
    kind: 'counter',
    unit: '{transition}',
    description: 'Circuit breaker state transitions',
    genAi: false,
  },
  usageFailureCount: {
    name: METRIC.usageFailureCount,
    kind: 'counter',
    unit: '{failure}',
    description: 'Attempts that spent tokens and then failed',
    genAi: false,
  },
};
