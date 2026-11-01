import type { LogLevel } from './sink.js';
import type { SeriesSnapshot } from './stats.js';
import type { FinishReason } from 'vern-llm';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** One target tried during a call, in order. For a call with several chains, the kept chain's. */
export interface PathEntry {
  provider: string;
  model: string;
  attempts: number;
  outcome: 'ok' | 'error';
  elapsedMs: number;
  errorCode?: string;
}

/** Token counts only. */
export interface UsageFields {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteTokensByTtl?: Record<string, number>;
}

export interface BreakerChange {
  provider: string;
  model: string;
  from: string;
  to: string;
}

export interface MiddlewareNote {
  kind: 'wrap_short_circuit' | 'transform' | 'enabled_skip';
  name: string;
  patchedFields?: string[];
}

/** The frozen record written once for every call. */
export interface CallLogRecord {
  kind: 'call';
  v: 1;
  /** ISO timestamp of when the call ended. */
  ts: string;
  requestId: string;
  /** `rejected` is a deliberate denial, logged at `warn` and never grouped with errors. */
  outcome: 'ok' | 'error' | 'aborted' | 'rejected';
  level: LogLevel;
  reason?: 'slow';
  /** Who answered. */
  provider?: string;
  model?: string;
  fallbackIndex?: number;
  /** Why the answering target stopped, when its adapter reports it. */
  finishReason?: FinishReason;
  /** Every attempt of every chain. */
  attempts: number;
  retries: number;
  streaming: boolean;
  /** Only for `cachedCall` when no attempt ran: `hit` from the cache, `join` a shared call. */
  cache?: 'hit' | 'join';
  shortCircuitedBy?: string;
  /** How many chains ran. Only for calls that ran more than one; `attempts` counts all of them. */
  chains?: number;
  /** The chain whose answer was kept, `0` for the main chain. Set whenever `chains` is. */
  chain?: number;
  durationMs: number;
  /** The answering attempt of the kept chain, from the request to the response or first chunk. */
  attemptMs?: number;
  /** Call start to the kept chain's first content chunk, streams only. */
  ttftMs?: number;
  queueWaitMs: number;
  retryDelayMs: number;
  outputTokensPerSec?: number;
  path: PathEntry[];
  usage?: UsageFields;
  /** The usage is from an attempt whose post processing then failed. */
  usageFailed?: true;
  /** Never the message, which can contain prompt text. */
  error?: { type: string; code?: string; status?: number };
  breaker?: BreakerChange[];
  middleware?: MiddlewareNote[];
  custom?: Record<string, JsonValue[]>;
  /** Allowlisted `context` keys only. */
  context?: Record<string, JsonValue>;
  /** Whatever `enrich` returned, merged in order. */
  fields?: Record<string, JsonValue>;
}

export interface SummaryEntry {
  kind: 'summary';
  v: 1;
  series: SeriesSnapshot;
  exemplar?: { requestId: string; durationMs: number; fields?: Record<string, JsonValue> };
}

export interface ErrorGroupEntry {
  kind: 'error_group';
  v: 1;
  provider: string;
  type: string;
  code?: string;
  count: number;
  windowMs: number;
  firstRequestId: string;
  lastRequestId: string;
}

/** A circuit breaker change, written even when it happened outside any call. */
export interface BreakerEntry {
  kind: 'breaker';
  v: 1;
  provider: string;
  model: string;
  from: string;
  to: string;
  consecutiveFailures: number;
}

export type LogEntry = CallLogRecord | SummaryEntry | ErrorGroupEntry | BreakerEntry;
