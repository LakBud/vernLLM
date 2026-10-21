import {
  context as contextApi,
  INVALID_SPAN_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import {
  isStreamResult,
  type AttemptContext,
  type CallMeta,
  type PreDispatchContext,
  type VernLLMEvent,
  type WireCallRequest,
} from 'vern-llm';

import { sanitizeAttributes } from '../attributes/sanitize.utils.js';
import {
  attemptStartAttributes,
  callEndAttributes,
  callStartAttributes,
  customEventAttributes,
  noAttemptReasonOf,
  usageAttributes,
  usageFailureAttributes,
} from '../attributes/spanAttributes.utils.js';
import { elapsedMs, nowMs } from '../clock.utils.js';
import {
  errorAttributes,
  errorTypeOf,
  exceptionOf,
  isLocalRejection,
  lastAttemptErrorOf,
  statusMessageOf,
} from '../errors/errorMapping.utils.js';
import {
  ATTEMPT_OUTCOME_UNKNOWN,
  ATTR,
  CALL_OUTCOME,
  EVENT_ATTR,
  NO_ATTEMPT_REASON,
  OPERATION_CHAT,
  SPAN,
  SPAN_EVENT,
  VERNLLM_ATTR,
} from '../semconv.js';
import { DeferredSpan } from './deferredSpan.js';

import type { Failure, Outcome, TrackerDeps } from '../../types/index.js';

interface Attempt {
  /** Started on first use, see `DeferredSpan`. */
  span: DeferredSpan;
  /** When the request was handed to the adapter, after the rate limiter and every transform. */
  startedAtMs: number;
  /** The same moment on the wall clock, which dates the span if it starts later. */
  startedAtEpochMs: number;
  /** When the response arrived, or for a stream its first content chunk. */
  respondedAtMs: number | undefined;
  provider: string;
  model: string;
  /** Status and duration are final. The span itself may stay open, see `applyUsage`. */
  settled: boolean;
  /** Time to first chunk was recorded. */
  firstChunkRecorded: boolean;
}

// Stands in for an attempt span that could not be created, so the code after it needs no checks.
const NON_RECORDING_SPAN = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);

/**
 * All the state for one logical call. Everything stateful in the package lives here, so a call
 * can never see another call's data, and every way out ends through `complete`.
 */
export class CallTracker {
  private readonly startedAtMs = nowMs();
  private attemptCount = 0;
  private current: Attempt | undefined;
  private streaming = false;
  private shortCircuitedBy: string | undefined;
  private meta: CallMeta | undefined;
  private ended = false;
  /** Local rate limit waiting reported for the attempt about to be dispatched. */
  private pendingWaitMs = 0;

  private constructor(
    private readonly deps: TrackerDeps,
    private readonly span: Span,
    private readonly context: Context,
    private readonly captureContent: boolean,
  ) {}

  static start(
    deps: TrackerDeps,
    ctx: PreDispatchContext,
    request: Readonly<WireCallRequest>,
  ): CallTracker {
    const { config, guard } = deps;

    // The parent is whatever context is active now, so an app's own request or agent span
    // adopts this call without any configuration.
    const parent = contextApi.active();
    const span = deps
      .getTracer()
      .startSpan(
        SPAN.call,
        { kind: SpanKind.INTERNAL, attributes: callStartAttributes(ctx) },
        parent,
      );

    // Stored explicitly, so attempts stay children of this span even when no context manager
    // is installed and `context.with` cannot carry it.
    const callContext = trace.setSpan(parent, span);

    // Best effort: the span exists from here on, so a failure while decorating it must not lose
    // the tracker, or the span would never be ended.
    let captureContent = false;
    guard(
      'startCallDetails',
      () => {
        if (!span.isRecording()) return;

        // The span already carries our start attributes, and the user's are written over them,
        // so ours are applied once more afterwards. A custom attribute can then never replace a
        // `vernllm.*` one, and the end attributes are written later still.
        const extra = guard('attributes', () => config.attributes?.(ctx), undefined);
        span.setAttributes(sanitizeAttributes(extra));
        span.setAttributes(callStartAttributes(ctx));

        if (deps.content) {
          captureContent = guard(
            'decideCapture',
            () => deps.content!.decide(ctx, request, span),
            false,
          );
          span.setAttribute(VERNLLM_ATTR.contentCaptured, captureContent);
        }
      },
      undefined,
    );

    return new CallTracker(deps, span, callContext, captureContent);
  }

  /** Runs `next` with the call span active, so anything it starts nests under the call. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.withActive(this.context, fn);
  }

  /**
   * Wraps one attempt's provider request. The attempt span is active while it runs, so an HTTP
   * client span nests under it, and it covers only the provider: the rate limit wait and every
   * transform are already behind it. Rethrows the exact error `next` threw.
   */
  async dispatch(
    ctx: AttemptContext,
    request: Readonly<WireCallRequest>,
    next: () => Promise<void>,
  ): Promise<void> {
    const attempt = this.deps.guard<Attempt | undefined>(
      'startAttempt',
      () => this.startAttempt(ctx, request),
      undefined,
    );
    if (!attempt) return next();

    let failure: Failure | undefined;
    try {
      await this.withActive(trace.setSpan(this.context, attempt.span), next);
    } catch (error) {
      failure = { error };
    }

    this.deps.guard('endDispatch', () => this.endDispatch(attempt, failure), undefined);
    if (failure) throw failure.error;
  }

  private withActive<T>(context: Context, fn: () => Promise<T>): Promise<T> {
    // `fn` is always one of the core's memoized `next` functions, so a failed `context.with`
    // falling back to calling it directly cannot send the request twice.
    const activated = this.deps.guard<Promise<T> | undefined>(
      'activateContext',
      () => contextApi.with(context, fn),
      undefined,
    );
    return activated ?? fn();
  }

  startAttempt(ctx: AttemptContext, request: Readonly<WireCallRequest>): Attempt | undefined {
    if (this.ended) return undefined;

    // A new attempt while one is still open means a closing signal was missed, so how that
    // attempt ended is unknown. It is closed without a status or a duration measurement rather
    // than being reported as a success.
    this.abandonAttempt();
    this.attemptCount++;

    const waitedMs = this.pendingWaitMs;
    this.pendingWaitMs = 0;

    // A hand built context can predate `adapter`, so its absence is not an error.
    const provider = this.deps.config.providerName(
      ctx.requestedProvider,
      ctx.requestedModel,
      ctx.adapter?.provider,
    );
    const startedAtMs = nowMs();
    const startedAtEpochMs = Date.now();

    const attempt: Attempt = {
      span: new DeferredSpan(() =>
        this.startAttemptSpan(ctx, request, provider, startedAtEpochMs, waitedMs),
      ),
      startedAtMs,
      startedAtEpochMs,
      respondedAtMs: undefined,
      provider,
      model: ctx.requestedModel,
      settled: false,
      firstChunkRecorded: false,
    };
    this.current = attempt;
    return attempt;
  }

  /** Creates the attempt span once something needs it. Never throws. */
  private startAttemptSpan(
    ctx: AttemptContext,
    request: Readonly<WireCallRequest>,
    provider: string,
    startedAtEpochMs: number,
    waitedMs: number,
  ): Span {
    const { config, guard } = this.deps;
    const genAi = config.genAiConventions;

    const span = guard<Span | undefined>(
      'startAttemptSpan',
      () =>
        this.deps.getTracer().startSpan(
          genAi ? `${OPERATION_CHAT} ${ctx.requestedModel}` : SPAN.attemptFallbackName,
          {
            kind: genAi ? SpanKind.CLIENT : SpanKind.INTERNAL,
            // The span can start after the request did, so it is dated to when it was sent. Whole
            // wall clock milliseconds, like a span started without a time, so the two order the
            // same way.
            startTime: startedAtEpochMs,
            attributes: attemptStartAttributes(
              {
                provider,
                target: ctx.requestedProvider,
                model: ctx.requestedModel,
                attempt: ctx.attempt,
                isFallback: ctx.isFallbackAttempt,
                request,
              },
              genAi,
            ),
          },
          this.context,
        ),
      undefined,
    );
    if (!span) return NON_RECORDING_SPAN;

    if (waitedMs > 0) {
      this.safely('markRateLimit', () => span.setAttribute(VERNLLM_ATTR.rateLimitWaitMs, waitedMs));
    }

    // `request` is what the adapter received, after every transform, so a redacting transform
    // has always run by now, whatever the middleware order.
    if (this.captureContent && this.deps.content) {
      const { content } = this.deps;
      guard('captureInput', () => content.captureInput(span, request), undefined);
    }

    return span;
  }

  private endDispatch(attempt: Attempt, failure: Failure | undefined): void {
    // Superseded, or already closed by the end of the call.
    if (attempt !== this.current) return;

    if (!failure) {
      attempt.respondedAtMs = nowMs();
      this.applyStreaming(attempt);
      return;
    }

    // Rejected before anything was sent, such as a capability the model does not have. That is
    // not an inference operation, so it leaves no span, no duration, and no attempt count,
    // unless something already started the span.
    if (!attempt.span.started && isLocalRejection(failure.error)) {
      this.current = undefined;
      this.attemptCount--;
      return;
    }

    this.closeAttempt(failure);
  }

  /** Span work for one event. Metrics are recorded separately, before this runs. */
  applyEvent(event: VernLLMEvent): void {
    // A late event still fed metrics, but the spans are already ended.
    if (this.ended) return;

    switch (event.kind) {
      case 'retry':
        this.addEvent(SPAN_EVENT.retry, {
          [EVENT_ATTR.attempt]: event.attempt,
          [EVENT_ATTR.delayMs]: event.delayMs,
          [EVENT_ATTR.retryAfterHonored]: event.retryAfterHonored,
          [ATTR.errorType]: errorTypeOf(event.error),
        });
        this.pendingWaitMs = 0;
        this.closeAttempt({ error: event.error });
        return;
      case 'fallback':
        this.addEvent(SPAN_EVENT.fallback, {
          [EVENT_ATTR.from]: event.from,
          [EVENT_ATTR.to]: event.to,
          [EVENT_ATTR.elapsedMs]: event.elapsedMs,
          [ATTR.errorType]: errorTypeOf(event.error),
        });
        this.pendingWaitMs = 0;
        this.closeAttempt({ error: event.error });
        return;
      case 'rate_limited':
        this.applyRateLimit(event.waitedMs);
        return;
      case 'circuit_state':
        this.addEvent(SPAN_EVENT.circuitState, {
          [EVENT_ATTR.provider]: event.provider,
          [EVENT_ATTR.model]: event.model,
          [EVENT_ATTR.from]: event.from,
          [EVENT_ATTR.to]: event.to,
          [EVENT_ATTR.consecutiveFailures]: event.consecutiveFailures,
        });
        return;
      case 'usage':
        this.applyUsage(event, false);
        return;
      case 'usage_failure':
        this.applyUsage(event, true);
        return;
      case 'middleware':
        if (event.hook === 'wrap_short_circuit') this.shortCircuitedBy = event.middleware;
        if (this.deps.config.middlewareEvents) {
          this.addEvent(SPAN_EVENT.middleware, {
            [EVENT_ATTR.name]: event.middleware,
            [EVENT_ATTR.hook]: event.hook,
            [EVENT_ATTR.patchedFields]: event.patchedFields,
          });
        }
        return;
      case 'custom': {
        const { customEvents } = this.deps.config;
        if (customEvents) this.addEvent(event.name, customEventAttributes(event, customEvents));
        return;
      }
    }
  }

  /** Context measurements are recorded against, so exemplars link to the right span. */
  measurementContext(): Context {
    const span = this.current?.span;
    return span ? trace.setSpan(this.context, span) : this.context;
  }

  /** The only exit. Ends every open span, whichever way the call ended. */
  finish(outcome: Outcome): void {
    switch (outcome.kind) {
      case 'error':
        this.complete({ error: outcome.error });
        return;
      case 'streamSettled':
        this.complete(outcome.failure, outcome.value);
        return;
      case 'result':
        this.meta = outcome.result.meta;
        if (isStreamResult(outcome.result.value)) this.openStream(outcome.result.value);
        else this.complete(undefined, outcome.result.value);
        return;
    }
  }

  private openStream(stream: { finalResult: PromiseLike<unknown> }): void {
    this.streaming = true;

    if (this.deps.config.genAiConventions) {
      this.safely('markStream', () => this.span.setAttribute(ATTR.requestStream, true));
    }

    // The core resolves a stream on a keep-alive ping, before content. The first chunk is timed
    // when the answering attempt's dispatch settles, which is here if that already happened.
    if (this.current) this.applyStreaming(this.current);

    // Observed on the side and never replaced: a derived promise that rethrows would create an
    // unhandled rejection the core deliberately avoids, and swapping `chunks` would change its
    // buffering and single use behaviour.
    try {
      void stream.finalResult.then(
        (value) => {
          this.deps.guard('finish', () => this.finish({ kind: 'streamSettled', value }), undefined);
        },
        (error: unknown) => {
          this.deps.guard(
            'finish',
            () => this.finish({ kind: 'streamSettled', failure: { error } }),
            undefined,
          );
        },
      );
    } catch (error) {
      // Nothing will ever settle this call, so end its spans now rather than leak them.
      this.complete(undefined);
      throw error;
    }
  }

  /** The wait comes before its attempt is dispatched, so it is held for that attempt. */
  private applyRateLimit(waitedMs: number): void {
    if (!Number.isFinite(waitedMs) || waitedMs <= 0) return;
    this.pendingWaitMs += waitedMs;
  }

  /**
   * Time to first chunk: from sending the request to the first content chunk, so keep-alive
   * pings never count. Needs both the stream and the attempt's response, which arrive in either
   * order, so it runs from both sides and records once.
   */
  private applyStreaming(attempt: Attempt): void {
    if (!this.streaming || attempt.respondedAtMs === undefined || attempt.firstChunkRecorded) {
      return;
    }
    attempt.firstChunkRecorded = true;

    const seconds = elapsedMs(attempt.startedAtMs, attempt.respondedAtMs) / 1000;
    this.deps.metrics.record(
      'timeToFirstChunk',
      seconds,
      this.attemptMetricAttributes(attempt),
      trace.setSpan(this.context, attempt.span),
    );

    // The same measurement as the metric, so the two can never disagree.
    if (this.deps.config.genAiConventions) {
      this.safely('markFirstChunk', () =>
        attempt.span.setAttributes({
          [ATTR.requestStream]: true,
          [ATTR.responseTimeToFirstChunk]: seconds,
        }),
      );
    }
  }

  private applyUsage(
    event: Extract<VernLLMEvent, { kind: 'usage' | 'usage_failure' }>,
    failed: boolean,
  ): void {
    const attempt = this.current;
    if (!attempt) return;

    const { genAiConventions } = this.deps.config;
    const usage = {
      promptTokens: event.usage.promptTokens,
      completionTokens: event.usage.completionTokens,
      reasoningTokens: event.usage.reasoningTokens,
      cacheReadTokens: event.usage.cacheReadTokens,
      cacheWriteTokens: event.usage.cacheWriteTokens,
    };

    this.safely('markUsage', () =>
      attempt.span.setAttributes(
        failed
          ? usageFailureAttributes(usage, genAiConventions)
          : usageAttributes(usage, genAiConventions),
      ),
    );

    // Tokens spent on an attempt that then failed are recorded, but the failure is closed by
    // the retry, fallback, or error that follows.
    if (!failed) this.settle(attempt, undefined);
  }

  /**
   * Span writes are best effort. A failing one is logged and must never stop the ending of the
   * span, or the metrics, that come after it.
   */
  private safely(operation: string, fn: () => void): void {
    this.deps.guard(operation, fn, undefined);
  }

  private recordException(span: Span, error: unknown): void {
    const { exceptions } = this.deps.config;
    if (exceptions) span.recordException(exceptionOf(error, exceptions.stack));
  }

  private addEvent(name: string, attributes: Attributes): void {
    this.safely('addSpanEvent', () => {
      if (this.span.isRecording()) this.span.addEvent(name, sanitizeAttributes(attributes));
    });
  }

  private attemptMetricAttributes(attempt: Attempt, failure?: Failure): Attributes {
    const attributes: Attributes = {
      [ATTR.operationName]: OPERATION_CHAT,
      [ATTR.providerName]: attempt.provider,
      [ATTR.requestModel]: attempt.model,
    };
    if (failure) attributes[ATTR.errorType] = errorTypeOf(failure.error);
    return attributes;
  }

  /**
   * Fixes an attempt's outcome and records its duration, once. Ending the span is separate: the
   * answering attempt stays open until the call settles so its output can still be recorded.
   */
  private settle(attempt: Attempt, failure: Failure | undefined): void {
    if (attempt.settled) return;
    attempt.settled = true;

    const { span } = attempt;

    this.deps.metrics.record(
      'operationDuration',
      elapsedMs(attempt.startedAtMs) / 1000,
      this.attemptMetricAttributes(attempt, failure),
      trace.setSpan(this.context, span),
    );

    this.safely('settleSpan', () => {
      if (failure) {
        span.setAttributes(errorAttributes(failure.error));
        span.setStatus({ code: SpanStatusCode.ERROR, message: statusMessageOf(failure.error) });
        this.recordException(span, failure.error);
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
    });
  }

  /** Ends an attempt whose outcome was never observed, see `startAttempt`. */
  private abandonAttempt(): void {
    const attempt = this.current;
    if (!attempt) return;

    attempt.settled = true;
    this.current = undefined;
    this.safely('abandonAttempt', () =>
      attempt.span.setAttribute(VERNLLM_ATTR.attemptOutcome, ATTEMPT_OUTCOME_UNKNOWN),
    );
    this.safely('endAttemptSpan', () => attempt.span.end());
  }

  /** The single place an attempt ends. */
  private closeAttempt(failure: Failure | undefined): void {
    const attempt = this.current;
    if (!attempt) return;

    try {
      this.settle(attempt, failure);
    } finally {
      this.current = undefined;
      this.safely('endAttemptSpan', () => attempt.span.end());
    }
  }

  private complete(failure: Failure | undefined, value?: unknown): void {
    if (this.ended) return;
    this.ended = true;

    const { deps, span } = this;
    const { guard, metrics } = deps;

    try {
      const attempt = this.current;
      if (attempt) {
        // The answering attempt never got a usage event when the provider omitted usage.
        const attemptFailure = failure && { error: lastAttemptErrorOf(failure.error) };
        guard('settleAttempt', () => this.settle(attempt, attemptFailure), undefined);

        if (!failure && this.captureContent && deps.content) {
          const { content } = deps;
          guard('captureOutput', () => content.captureOutput(attempt.span, value), undefined);
        }
        this.closeAttempt(attemptFailure);
      }

      const reason = failure
        ? undefined
        : noAttemptReasonOf({
            attemptCount: this.attemptCount,
            hasMeta: this.meta !== undefined,
            shortCircuitedBy: this.shortCircuitedBy,
          });

      this.safely('endCallSpan', () => {
        if (span.isRecording()) {
          span.setAttributes(
            callEndAttributes({
              meta: this.meta,
              totalAttempts: this.attemptCount,
              streaming: this.streaming,
              noAttemptReason: reason,
              shortCircuitedBy:
                reason === NO_ATTEMPT_REASON.shortCircuit ? this.shortCircuitedBy : undefined,
            }),
          );
        }

        if (failure) {
          span.setAttributes(errorAttributes(failure.error));
          span.setStatus({ code: SpanStatusCode.ERROR, message: statusMessageOf(failure.error) });
          this.recordException(span, failure.error);
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
      });

      const outcome = failure ? CALL_OUTCOME.error : outcomeOf(reason);
      const attributes: Attributes = { [VERNLLM_ATTR.callOutcome]: outcome };
      if (failure) attributes[ATTR.errorType] = errorTypeOf(failure.error);
      if (this.meta) attributes[VERNLLM_ATTR.usedFallback] = this.meta.usedFallback === true;

      const callContext = this.context;
      metrics.record('callDuration', elapsedMs(this.startedAtMs) / 1000, attributes, callContext);
      metrics.record(
        'callAttempts',
        this.attemptCount,
        { [VERNLLM_ATTR.callOutcome]: outcome },
        callContext,
      );
    } finally {
      span.end();
    }
  }
}

function outcomeOf(reason: ReturnType<typeof noAttemptReasonOf>): string {
  switch (reason) {
    case NO_ATTEMPT_REASON.cacheHit:
      return CALL_OUTCOME.cacheHit;
    case NO_ATTEMPT_REASON.coalesced:
      return CALL_OUTCOME.coalesced;
    case NO_ATTEMPT_REASON.shortCircuit:
      return CALL_OUTCOME.shortCircuit;
    default:
      return CALL_OUTCOME.ok;
  }
}
