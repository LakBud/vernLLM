import { pickUsage } from './inputs.utils.js';
import { outputTokensPerSec, roundMs } from './recordMetrics.utils.js';

import type { CallLogRecord, JsonValue } from '../../types/index.js';
import type { RecordInput } from './recordInput.types.js';

/** Frozen copies in a frozen list, so nothing a sink holds can change what the next one reads. */
function frozenCopies<T extends object>(items: readonly T[]): T[] {
  return Object.freeze(items.map((item) => Object.freeze({ ...item }))) as T[];
}

/** Frozen copies of each event list, so the recorder's live lists never reach a sink. */
function frozenCustom(custom: RecordInput['custom']): NonNullable<CallLogRecord['custom']> {
  const copy: NonNullable<CallLogRecord['custom']> = {};
  for (const [name, values] of custom) copy[name] = Object.freeze([...values]) as JsonValue[];
  return Object.freeze(copy);
}

/** The fields every record has, whatever happened. */
function baseRecord(input: RecordInput): CallLogRecord {
  return {
    kind: 'call',
    v: 1,
    ts: input.endedAt.toISOString(),
    requestId: input.requestId,
    outcome: input.classified.outcome,
    level: input.classified.level,
    attempts: input.attempts,
    retries: input.retries,
    streaming: input.streaming,
    durationMs: roundMs(input.durationMs),
    queueWaitMs: roundMs(input.queueWaitMs),
    retryDelayMs: roundMs(input.retryDelayMs),
    path: frozenCopies(input.path),
  };
}

/** Who answered, how long it took, and what short circuited the call. */
function addAnswer(record: CallLogRecord, input: RecordInput): void {
  const { answered } = input;
  if (answered) {
    record.provider = answered.provider;
    record.model = answered.model;
    record.fallbackIndex = answered.fallbackIndex;
  }
  if (input.chains) {
    record.chains = input.chains.count;
    record.chain = input.chains.kept;
  }
  if (input.cache !== undefined) record.cache = input.cache;
  if (input.attemptMs !== undefined) record.attemptMs = roundMs(input.attemptMs);
  if (input.ttftMs !== undefined) record.ttftMs = roundMs(input.ttftMs);
  if (input.shortCircuitedBy !== undefined) record.shortCircuitedBy = input.shortCircuitedBy;
}

function addUsage(record: CallLogRecord, input: RecordInput): void {
  if (!input.usage) return;

  record.usage = Object.freeze(pickUsage(input.usage));
  if (input.usageFailed) record.usageFailed = true;
  const rate = outputTokensPerSec(input.usage.completionTokens, input.generationMs);
  if (rate !== undefined) record.outputTokensPerSec = rate;
}

/** What other parts of the call left behind, written only when there is something to write. */
function addNotes(record: CallLogRecord, input: RecordInput): void {
  if (input.classified.error) record.error = Object.freeze({ ...input.classified.error });
  if (input.breaker.length > 0) record.breaker = frozenCopies(input.breaker);
  if (input.middleware.length > 0) record.middleware = frozenCopies(input.middleware);
  if (input.custom.size > 0) record.custom = frozenCustom(input.custom);
  if (input.context) record.context = Object.freeze(input.context);
  if (input.fields) record.fields = Object.freeze(input.fields);
}

/** Builds the one frozen record. Absent fields are left out, never written as `undefined`. */
export function buildRecord(input: RecordInput): CallLogRecord {
  const record = baseRecord(input);
  addAnswer(record, input);
  addUsage(record, input);
  addNotes(record, input);
  return Object.freeze(record);
}
