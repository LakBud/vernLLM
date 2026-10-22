import { elapsedMs, nowMs } from '../clock.utils.js';
import { attachTallies, type AttemptTally } from '../stats/attemptTally.utils.js';
import { buildRecord } from './buildRecord.utils.js';
import {
  closeLastTarget,
  closeTargetAsFailed,
  enterTarget,
  leaveTarget,
  pathEntryOf,
  type OpenAttempt,
  type PathState,
} from './callPath.utils.js';
import { timingsOf } from './callTimings.utils.js';
import { pickContext, runEnrichers } from './inputs.utils.js';
import {
  classifyOutcome,
  isLocalRejection,
  isQualityFailure,
  lastAttemptErrorOf,
  type RecorderOutcome,
} from './outcome.utils.js';

import type {
  BreakerChange,
  CallLogRecord,
  JsonValue,
  MiddlewareNote,
  ResolvedConfig,
} from '../../types/index.js';
import type { Guard } from '../guard.utils.js';
import type { AttemptContext, CallMeta, PreDispatchContext, TokenUsage } from 'vern-llm';

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
  private readonly tallies = new Map<PathState, AttemptTally>();

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

    const entry = enterTarget(this.path, ctx);
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
      leaveTarget(this.path, attempt);
      return;
    }

    this.settle(attempt, { error });
  }

  /** A retry follows: the open attempt failed with `error`. */
  retried(delayMs: number, error: unknown): void {
    if (this.ended) return;
    this.settleOpen({ error });
    this.retries++;
    if (Number.isFinite(delayMs) && delayMs > 0) this.retryDelayMs += delayMs;
  }

  /** The call moves on to the next target: the open attempt and its target are finished. */
  fellBack(elapsedMsOnTarget: number, error: unknown): void {
    if (this.ended) return;
    this.settleOpen({ error });
    closeTargetAsFailed(this.path, elapsedMsOnTarget, error);
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
    if (open) {
      this.settle(
        open,
        outcome.kind === 'error' ? { error: lastAttemptErrorOf(failure) } : undefined,
      );
    }

    const timings = timingsOf({
      open,
      answered: outcome.kind === 'result',
      streaming: this.streaming,
      startedAtMs: this.startedAtMs,
      endedAtMs,
    });
    closeLastTarget(this.path, endedAtMs, { failed: outcome.kind === 'error', error: failure });

    const meta: CallMeta | undefined = outcome.kind === 'result' ? outcome.result.meta : undefined;
    const classified = classifyOutcome(outcome);

    const record = buildRecord({
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
      ttftMs: timings.ttftMs,
      shortCircuitedBy: this.shortCircuitedBy,
      durationMs: elapsedMs(this.startedAtMs, endedAtMs),
      queueWaitMs: this.queueWaitMs,
      retryDelayMs: this.retryDelayMs,
      attemptMs: timings.attemptMs,
      generationMs: timings.generationMs,
      path: this.path.map((entry) => pathEntryOf(entry)),
      usage: this.usage,
      usageFailed: this.usageFailed,
      breaker: this.breaker,
      middleware: this.middleware,
      custom: this.custom,
      context: pickContext(this.ctx.context, this.config.context),
      fields: runEnrichers(this.config.enrich, this.ctx, this.guard),
    });

    attachTallies(record, [...this.tallies.values()]);
    return record;
  }

  /** Settles the open attempt, if any, and leaves none open. */
  private settleOpen(failure: { error: unknown }): void {
    const attempt = this.current;
    this.current = undefined;
    if (attempt) this.settle(attempt, failure);
  }

  /**
   * Counts one finished attempt for the quality failure rate. A `failure` is the error that ended
   * it, absent when it answered. It got a response when `dispatch` resolved, or when its error
   * says the answer arrived and was unusable.
   */
  private settle(attempt: OpenAttempt, failure?: { error: unknown }): void {
    const failedQuality = failure !== undefined && isQualityFailure(failure.error);
    const responded = failure === undefined || failedQuality || attempt.respondedAtMs !== undefined;
    if (!responded) return;

    let tally = this.tallies.get(attempt.path);
    if (!tally) {
      tally = {
        provider: attempt.path.provider,
        model: attempt.path.model,
        responded: 0,
        qualityFailures: 0,
      };
      this.tallies.set(attempt.path, tally);
    }
    tally.responded++;
    if (failedQuality) tally.qualityFailures++;
  }
}
