import { pickUsage } from './inputs.utils.js';

import type {
  BreakerChange,
  CallLogRecord,
  JsonValue,
  MiddlewareNote,
  PathEntry,
} from '../../types/index.js';
import type { ClassifiedOutcome } from './outcome.utils.js';
import type { TokenUsage } from 'vern-llm';

export interface RecordInput {
  requestId: string;
  endedAt: Date;
  classified: ClassifiedOutcome;
  /** Who answered, from the call's `meta`. */
  answered: { provider: string; model: string; fallbackIndex: number } | undefined;
  attempts: number;
  retries: number;
  streaming: boolean;
  /** Set only when no attempt ran and the call still answered. */
  cache: 'hit' | 'join' | undefined;
  /** Call start to first content chunk, streams only. */
  ttftMs: number | undefined;
  shortCircuitedBy: string | undefined;
  durationMs: number;
  queueWaitMs: number;
  retryDelayMs: number;
  /** How long the answering attempt took to respond. */
  attemptMs: number | undefined;
  /** The window the output tokens were produced in, for the token rate. */
  generationMs: number | undefined;
  path: readonly PathEntry[];
  usage: TokenUsage | undefined;
  usageFailed: boolean;
  breaker: readonly BreakerChange[];
  middleware: readonly MiddlewareNote[];
  custom: ReadonlyMap<string, JsonValue[]>;
  context: Record<string, JsonValue> | undefined;
  fields: Record<string, JsonValue> | undefined;
}

/** Milliseconds to the microsecond: raw clock floats are noise in a log line. */
export const roundMs = (value: number): number => Math.round(value * 1000) / 1000;

/** `completionTokens` per second of the attempt, or `undefined` without both. */
export function outputTokensPerSec(
  completionTokens: number | undefined,
  attemptMs: number | undefined,
): number | undefined {
  if (completionTokens === undefined || attemptMs === undefined) return undefined;
  if (!Number.isFinite(completionTokens) || completionTokens <= 0 || attemptMs <= 0) {
    return undefined;
  }
  return roundMs(completionTokens / (attemptMs / 1000));
}

/** Builds the one frozen record. Absent fields are left out, never written as `undefined`. */
export function buildRecord(input: RecordInput): CallLogRecord {
  const { classified, answered } = input;

  const record: CallLogRecord = {
    kind: 'call',
    v: 1,
    ts: input.endedAt.toISOString(),
    requestId: input.requestId,
    outcome: classified.outcome,
    level: classified.level,
    attempts: input.attempts,
    retries: input.retries,
    streaming: input.streaming,
    durationMs: roundMs(input.durationMs),
    queueWaitMs: roundMs(input.queueWaitMs),
    retryDelayMs: roundMs(input.retryDelayMs),
    path: input.path.map((entry) => Object.freeze({ ...entry })),
  };

  if (answered) {
    record.provider = answered.provider;
    record.model = answered.model;
    record.fallbackIndex = answered.fallbackIndex;
  }
  if (input.cache !== undefined) record.cache = input.cache;
  if (input.attemptMs !== undefined) record.attemptMs = roundMs(input.attemptMs);
  if (input.ttftMs !== undefined) record.ttftMs = roundMs(input.ttftMs);
  if (input.shortCircuitedBy !== undefined) record.shortCircuitedBy = input.shortCircuitedBy;

  if (input.usage) {
    record.usage = Object.freeze(pickUsage(input.usage));
    if (input.usageFailed) record.usageFailed = true;
    const rate = outputTokensPerSec(input.usage.completionTokens, input.generationMs);
    if (rate !== undefined) record.outputTokensPerSec = rate;
  }

  if (classified.error) record.error = Object.freeze({ ...classified.error });
  if (input.breaker.length > 0) {
    record.breaker = input.breaker.map((change) => Object.freeze({ ...change }));
  }
  if (input.middleware.length > 0) {
    record.middleware = input.middleware.map((note) => Object.freeze({ ...note }));
  }
  if (input.custom.size > 0) record.custom = Object.freeze(Object.fromEntries(input.custom));
  if (input.context) record.context = Object.freeze(input.context);
  if (input.fields) record.fields = Object.freeze(input.fields);

  Object.freeze(record.path);
  if (record.breaker) Object.freeze(record.breaker);
  if (record.middleware) Object.freeze(record.middleware);
  return Object.freeze(record);
}
