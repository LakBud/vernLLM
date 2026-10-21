import type { BreakerChange, JsonValue, MiddlewareNote, PathEntry } from '../../types/index.js';
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
