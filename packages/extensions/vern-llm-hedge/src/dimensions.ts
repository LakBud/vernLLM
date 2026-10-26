import { HEDGE_DECISION_EVENT } from './events.js';
import { bucketOfTokens, type SizeBucket } from './internal/size.utils.js';

import type { HedgeOutcome } from './types/index.js';

/** The part of the logger's call record these read, so no import of the logger is needed. */
interface CallRecord {
  usage?: { promptTokens?: number };
  custom?: Record<string, unknown[]>;
}

const OUTCOMES: ReadonlySet<unknown> = new Set<HedgeOutcome>([
  'won',
  'lost',
  'not_needed',
  'failed',
  'aborted',
  'budget',
  'unavailable',
  'no_target',
  'not_allowed',
  'paused',
  'cached',
  'no_data',
  'deadline',
]);

/**
 * The prompt's size as a logger dimension, so a long prompt's slow first token never sets the
 * delay for a short one: `dimensions: { size: promptSizeDimension }`. Buckets by powers of four
 * from 1 000 prompt tokens: `xs` under 1k, `s` under 4k, `m` under 16k, `l` under 64k and `xl`
 * above. The hedge reads it under the name `size`. A record with no usage yields nothing.
 */
export const promptSizeDimension = (record: CallRecord): SizeBucket | undefined => {
  const tokens = record.usage?.promptTokens;
  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0
    ? bucketOfTokens(tokens)
    : undefined;
};

/**
 * How the call's hedge went, as a logger dimension: `dimensions: { hedge: hedgeDimension }`
 * splits the logger's counts and percentiles by `won`, `lost`, `not_needed`, `failed`, `aborted`, `budget` and the skip
 * reasons. It reads the call's last `hedge.decision`, so the logger must keep `hedge.*` events
 * (`customEvents: ['hedge.*']`). A call with no decision yields nothing.
 */
export const hedgeDimension = (record: CallRecord): HedgeOutcome | undefined => {
  const events = record.custom?.[HEDGE_DECISION_EVENT];
  const last = events?.[events.length - 1];
  if (typeof last !== 'object' || last === null) return undefined;

  const outcome = (last as { outcome?: unknown }).outcome;
  return OUTCOMES.has(outcome) ? (outcome as HedgeOutcome) : undefined;
};
