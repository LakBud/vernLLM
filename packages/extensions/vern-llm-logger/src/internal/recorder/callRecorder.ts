import {
  type AttemptContext,
  type CallMeta,
  type PreDispatchContext,
  type TokenUsage,
} from 'vern-llm';

import { elapsedMs, nowMs } from '../clock.utils.js';
import { buildRecord } from './buildRecord.utils.js';
import { pickContext, runEnrichers } from './inputs.utils.js';
import {
  classifyOutcome,
  errorCodeOf,
  isLocalRejection,
  lastAttemptErrorOf,
  type RecorderOutcome,
} from './outcome.utils.js';

import type {
  BreakerChange,
  CallLogRecord,
  JsonValue,
  MiddlewareNote,
  PathEntry,
  ResolvedConfig,
} from '../../types/index.js';
import type { Guard } from '../guard.utils.js';

/** One target tried during the call. Mutable until the target is left or the call ends. */
interface PathState {
  provider: string;
  model: string;
  attempts: number;
  startedAtMs: number;
  closed: boolean;
  outcome: PathEntry['outcome'];
  elapsedMs: number;
  errorCode: string | undefined;
}

/** The attempt whose outcome is not known yet. */
interface OpenAttempt {
  startedAtMs: number;
  /** When `dispatch` resolved. Parsing and validation may still fail after it. */
  respondedAtMs: number | undefined;
  path: PathState;
}

/**
 * All the state for one logical call. An attempt stays open after `dispatch` resolves, since
 * validation can still fail and retry, and is closed by the next retry, fallback or the end.
 */
export class CallRecorder {
  private readonly startedAtMs = nowMs();
  private ended = false;
  private streaming = false;
  private attemptCount = 0;
  private current: OpenAttempt | undefined;
  private retries = 0;
  private retryDelayMs = 0;
  private queueWaitMs = 0;
  private readonly path: PathState[] = [];
  private usage: TokenUsage | undefined;
  private usageFailed = false;
  private shortCircuitedBy: string | undefined;
  private readonly breaker: BreakerChange[] = [];
  private readonly middleware: MiddlewareNote[] = [];
  private readonly custom = new Map<string, JsonValue[]>();

  private constructor(
    private readonly ctx: PreDispatchContext,
    private readonly config: ResolvedConfig,
    private readonly guard: Guard,
  ) {}

  static start(ctx: PreDispatchContext, config: ResolvedConfig, guard: Guard): CallRecorder {
    return new CallRecorder(ctx, config, guard);
  }

  /** `dispatch` entered: one request is about to go to one target. */
  openAttempt(ctx: AttemptContext): void {
    if (this.ended) return;

    // A new attempt while one is still open means a closing signal was missed, so how that
    // attempt ended is unknown. It still counts, but its outcome is never guessed.
    this.current = undefined;
    this.attemptCount++;

    let entry = this.path[this.path.length - 1];
    if (!entry || entry.closed || entry.provider !== ctx.requestedProvider) {
      entry = {
        provider: ctx.requestedProvider,
        model: ctx.requestedModel,
        attempts: 0,
        startedAtMs: nowMs(),
        closed: false,
        outcome: 'error',
        elapsedMs: 0,
        errorCode: undefined,
      };
      this.path.push(entry);
    }
    entry.attempts++;
    this.current = { startedAtMs: nowMs(), respondedAtMs: undefined, path: entry };
  }

  /** `dispatch` resolved. The attempt stays open, see the class comment. */
  responded(): void {
    if (this.current) this.current.respondedAtMs = nowMs();
  }

  /** `dispatch` rejected: the adapter failed. */
  attemptFailed(error: unknown): void {
    const attempt = this.current;
    if (!attempt) return;
    this.current = undefined;

    // Rejected before anything was sent, such as a capability the model does not have. That
    // never reached a provider, so it is not an attempt and leaves no trace of one.
    if (isLocalRejection(error)) {
      this.attemptCount--;
      attempt.path.attempts--;
      if (attempt.path.attempts === 0) {
        const index = this.path.indexOf(attempt.path);
        // The entry was pushed by `openAttempt`, so it is always found.
        /* v8 ignore next */
        if (index !== -1) this.path.splice(index, 1);
      }
    }
  }

  /** A retry follows: the open attempt failed. */
  retried(delayMs: number): void {
    if (this.ended) return;
    this.current = undefined;
    this.retries++;
    if (Number.isFinite(delayMs) && delayMs > 0) this.retryDelayMs += delayMs;
  }

  /** The call moves on to the next target: the open attempt and its target are finished. */
  fellBack(elapsedMsOnTarget: number, error: unknown): void {
    if (this.ended) return;
    this.current = undefined;

    const entry = this.path[this.path.length - 1];
    if (!entry || entry.closed) return;

    entry.closed = true;
    entry.outcome = 'error';
    entry.errorCode = errorCodeOf(error);
    // The core's own figure, measured here only if it is missing.
    entry.elapsedMs =
      Number.isFinite(elapsedMsOnTarget) && elapsedMsOnTarget >= 0
        ? elapsedMsOnTarget
        : elapsedMs(entry.startedAtMs);
  }

  queued(waitedMs: number): void {
    if (!this.ended && Number.isFinite(waitedMs) && waitedMs > 0) this.queueWaitMs += waitedMs;
  }

  setUsage(usage: TokenUsage, failed: boolean): void {
    if (this.ended) return;
    this.usage = usage;
    this.usageFailed = failed;
  }

  noteBreaker(change: BreakerChange): void {
    if (!this.ended) this.breaker.push(change);
  }

  noteMiddleware(note: MiddlewareNote): void {
    if (this.ended) return;
    if (note.kind === 'wrap_short_circuit') this.shortCircuitedBy = note.name;
    this.middleware.push(note);
  }

  /** The caller decides whether the event is wanted. */
  addCustom(name: string, data: JsonValue | undefined): void {
    if (this.ended) return;
    const list = this.custom.get(name);
    // The core already caps custom events per call, so this list needs no cap of its own.
    if (list) list.push(data ?? null);
    else this.custom.set(name, [data ?? null]);
  }

  /** The call returned a stream, so the record is written when `finalResult` settles. */
  markStream(): void {
    if (!this.ended) this.streaming = true;
  }

  /** The only exit: builds the record once. Events after this are dropped. */
  finish(outcome: RecorderOutcome): CallLogRecord | undefined {
    if (this.ended) return undefined;
    this.ended = true;

    const endedAtMs = nowMs();
    const failure = outcome.kind === 'error' ? outcome.error : undefined;

    // The attempt still open here answered, or failed for the reason the call failed.
    const open = this.current;
    this.current = undefined;
    const respondedAtMs = open?.respondedAtMs;

    // The token rate of a stream is the generation window after its first chunk, not the wait
    // before it. That wait is `ttftMs`, measured from the call's start.
    let attemptMs: number | undefined;
    let generationMs: number | undefined;
    if (open && outcome.kind === 'result') {
      attemptMs = elapsedMs(open.startedAtMs, respondedAtMs ?? endedAtMs);
      generationMs = this.streaming ? elapsedMs(respondedAtMs ?? endedAtMs, endedAtMs) : attemptMs;
    }
    const ttftMs =
      this.streaming && respondedAtMs !== undefined
        ? elapsedMs(this.startedAtMs, respondedAtMs)
        : undefined;

    const last = this.path[this.path.length - 1];
    if (last && !last.closed) {
      last.closed = true;
      last.elapsedMs = elapsedMs(last.startedAtMs, endedAtMs);
      if (outcome.kind === 'error') {
        last.outcome = 'error';
        last.errorCode = errorCodeOf(lastAttemptErrorOf(failure));
      } else {
        last.outcome = 'ok';
      }
    }

    const meta: CallMeta | undefined = outcome.kind === 'result' ? outcome.result.meta : undefined;
    const classified = classifyOutcome(outcome);

    return buildRecord({
      requestId: this.ctx.requestId,
      endedAt: new Date(),
      classified,
      answered: meta && {
        provider: meta.provider,
        model: meta.model,
        fallbackIndex: meta.fallbackIndex,
      },
      attempts: this.attemptCount,
      retries: this.retries,
      streaming: this.streaming,
      cache:
        classified.outcome === 'ok' && outcome.kind === 'result' ? outcome.result.cache : undefined,
      ttftMs,
      shortCircuitedBy: this.shortCircuitedBy,
      durationMs: elapsedMs(this.startedAtMs, endedAtMs),
      queueWaitMs: this.queueWaitMs,
      retryDelayMs: this.retryDelayMs,
      attemptMs,
      generationMs,
      path: this.path.map((entry) => pathEntryOf(entry)),
      usage: this.usage,
      usageFailed: this.usageFailed,
      breaker: this.breaker,
      middleware: this.middleware,
      custom: this.custom,
      context: pickContext(this.ctx.context, this.config.context),
      fields: runEnrichers(this.config.enrich, this.ctx, this.guard),
    });
  }
}

function pathEntryOf(entry: PathState): PathEntry {
  const result: PathEntry = {
    provider: entry.provider,
    model: entry.model,
    attempts: entry.attempts,
    outcome: entry.outcome,
    elapsedMs: Math.round(entry.elapsedMs * 1000) / 1000,
  };
  if (entry.errorCode !== undefined) result.errorCode = entry.errorCode;
  return result;
}
