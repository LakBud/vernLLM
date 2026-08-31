import { CircuitBreaker, type CircuitBreakerCallContext } from '../../circuitBreaker.js';
import { LLMError } from '../../types/errors.js';
import { makeEventReporter } from '../utils/circuitBreaker.utils.js';
import { readRateLimitHint } from '../utils/rateLimitHint.utils.js';
import { type BreakerGateway } from './circuitBreakerContext.js';
import { RequestBuilder } from './requestBuilder.js';
import { finalizeResponse } from './responseFinalizer.js';
import { buildStreamResult } from './streamAccumulator.js';
import { createUsageReporter, type UsageReporter } from './usageReporter.js';
import { prepareAttempt, type OnRequest } from './utils/dispatch/attemptDispatch.utils.js';
import { runAttemptLoop } from './utils/dispatch/attemptLoop.utils.js';
import { extractStatus } from './utils/errors.utils.js';
import { DEFAULT_MIDDLEWARE_TIMEOUT_MS } from './utils/middleware.utils.js';
import { defaultParseJson } from './utils/parse.utils.js';
import { withTimeout } from './utils/retry/retry.utils.js';

import type { Logger } from '../../logger.js';
import type { RateLimiter } from '../../rateLimit.js';
import type {
  CallParams,
  CallWithToolsResult,
  DetectSoftFailure,
  LLMClient,
  MiddlewareStateBag,
  StreamChunk,
  TokenUsage,
  VernLLMEvent,
  VernLLMMiddleware,
  WireCallRequest,
} from '../../types/index.js';

export type { OnRequest };

/** Everything one `CallExecutor` needs beyond the client and model. */
export interface CallExecutorOptions {
  maxRetries: number;
  timeoutMs: number;
  chunkIdleTimeoutMs: number;
  baseDelayMs: number;
  defaultMaxTokens: number;
  defaultTemperature: number | null;
  defaultReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  defaultBudgetTokens?: number;
  nonRetryableStatus: number[];
  parseJson?: (content: string) => unknown;
  logger: Logger;
  /** Applied to model output before it reaches the debug logger. See `VernLLMOptions.redact`. */
  redact?: (text: string) => string;
  onUsage?: (usage: TokenUsage) => void;
  onUsageFailure?: (usage: TokenUsage, error: LLMError) => void;
  onEvent?: (event: VernLLMEvent) => void;
  breaker?: CircuitBreaker;
  limiter?: RateLimiter;
  /** True for every target after the primary. Stamped onto reported `TokenUsage`. */
  isFallback?: boolean;
  /** See `VernLLMOptions.middleware`. */
  middleware?: VernLLMMiddleware[];
  /** See `VernLLMOptions.middlewareTimeoutMs`. */
  middlewareTimeoutMs?: number;
  /** See `VernLLMOptions.detectSoftFailure`. */
  detectSoftFailure?: DetectSoftFailure;
}

/**
 * Everything one provider target needs to attempt a call: request
 * building, retry with backoff, the per-target breaker, the per-target
 * limiter. Never exported publicly. `VernLLM` holds one per target and
 * owns the fallback loop and caching on top.
 */
export class CallExecutor {
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly chunkIdleTimeoutMs: number;
  private readonly baseDelayMs: number;
  private readonly nonRetryableStatus: number[];
  private readonly parseJson: (content: string) => unknown;
  private readonly logger: Logger;
  private readonly redact?: (text: string) => string;
  private readonly usageReporter: UsageReporter;
  private readonly reportEvent: (event: VernLLMEvent) => void;
  private readonly breaker?: CircuitBreaker;
  private readonly limiter?: RateLimiter;
  private readonly isFallback: boolean;
  private readonly requestBuilder: RequestBuilder;
  private readonly middleware: VernLLMMiddleware[];
  private readonly middlewareTimeoutMs: number;
  private readonly supportsJsonObjectMode: boolean;
  private readonly detectSoftFailure?: DetectSoftFailure;

  constructor(
    readonly providerName: string,
    private readonly client: LLMClient,
    readonly model: string,
    options: CallExecutorOptions,
  ) {
    this.maxRetries = options.maxRetries;
    this.timeoutMs = options.timeoutMs;
    this.chunkIdleTimeoutMs = options.chunkIdleTimeoutMs;
    this.baseDelayMs = options.baseDelayMs;
    this.nonRetryableStatus = options.nonRetryableStatus;
    this.parseJson = options.parseJson ?? defaultParseJson;
    this.logger = options.logger;
    this.redact = options.redact;
    this.reportEvent = makeEventReporter(options.onEvent, this.logger);
    this.breaker = options.breaker;
    this.limiter = options.limiter;
    this.isFallback = options.isFallback ?? false;
    this.middleware = options.middleware ?? [];
    this.middlewareTimeoutMs = options.middlewareTimeoutMs ?? DEFAULT_MIDDLEWARE_TIMEOUT_MS;
    this.supportsJsonObjectMode = client.supportsJsonObjectMode ?? true;
    this.detectSoftFailure = options.detectSoftFailure;
    this.usageReporter = createUsageReporter({
      providerName: this.providerName,
      isFallback: this.isFallback,
      maxRetries: this.maxRetries,
      onUsage: options.onUsage,
      onUsageFailure: options.onUsageFailure,
      logger: this.logger,
    });
    this.requestBuilder = new RequestBuilder({
      model,
      defaultMaxTokens: options.defaultMaxTokens,
      defaultTemperature: options.defaultTemperature,
      defaultReasoningEffort: options.defaultReasoningEffort,
      defaultBudgetTokens: options.defaultBudgetTokens,
      supportsJsonObjectMode: this.supportsJsonObjectMode,
    });
  }

  /**
   * Builds this target's wire request for `params` without dispatching
   * it or applying any middleware `transform`. Used by `VernLLM` to hand
   * `wrap` middleware a representative request before the real,
   * per-attempt request (which does run `transform`) exists yet.
   */
  previewRequest<T>(params: CallParams<T>): { model: string; request: WireCallRequest } {
    const { model, request } = this.requestBuilder.build(params);
    return { model, request };
  }

  /** Whether this target's underlying client supports `response_format: 'json_object'`. Used to seed `MiddlewareContext.capabilities.supportsJsonObjectMode` for the primary target before a real request exists. */
  get jsonObjectModeSupported(): boolean {
    return this.supportsJsonObjectMode;
  }

  getCircuitState(model?: string) {
    return this.breaker?.getState(model);
  }

  /** Failure counts by `LLMErrorCode` for this target's breaker, if configured. Undefined otherwise. */
  getFailureBreakdown(model?: string) {
    return this.breaker?.getFailureBreakdown(model);
  }

  /** Whether this target's breaker tracks failures per model. `false` if no breaker is configured. */
  get isolateByModel(): boolean {
    return this.breaker?.isolateByModel ?? false;
  }

  /** Manually opens this target's circuit breaker, if one is configured. No-op otherwise. */
  openCircuit(model?: string, context?: CircuitBreakerCallContext): void {
    this.breaker?.open(model, context);
  }

  /** Manually closes this target's circuit breaker, if one is configured. No-op otherwise. */
  closeCircuit(model?: string, context?: CircuitBreakerCallContext): void {
    this.breaker?.close(model, context);
  }

  /**
   * Throws if the breaker is open for this target/model, exactly like the
   * check `run`/`runStream` used to make internally. Exposed so `VernLLM`
   * can gate on it before reserving usage, avoiding a reserve-then-refund
   * round trip on a call that was never going to be attempted. `assertClosed`
   * has a stateful side effect (claiming a half-open trial slot), so it must
   * run exactly once per logical call: `run`/`runStream` no longer call it
   * themselves, this is now the only call site.
   */
  assertBreakerClosed(model?: string, context?: CircuitBreakerCallContext): void {
    this.breaker?.assertClosed(model ?? this.model, context);
  }

  /**
   * Runs a single logical call against this target: retry with backoff,
   * normalized error on exhaustion. Mirrors the old `VernLLM.call`'s
   * non-streaming branch, minus cache/usage-reservation and the breaker
   * check, which stay one layer up since they aren't per-target concerns
   * (see `assertBreakerClosed`).
   */
  async run<T>(
    params: CallParams<T>,
    requestId: string,
    onAttempt?: () => void,
    state?: MiddlewareStateBag,
  ): Promise<T | CallWithToolsResult<T>> {
    return runAttemptLoop({
      fn: (attempt, onRequest, resolvedState, gateway) =>
        this.executeCall(params, requestId, attempt, onRequest, resolvedState, gateway),
      requestId,
      model: params.model ?? this.model,
      providerName: this.providerName,
      isFallback: this.isFallback,
      supportsJsonObjectMode: this.supportsJsonObjectMode,
      breaker: this.breaker,
      maxRetries: this.maxRetries,
      baseDelayMs: this.baseDelayMs,
      nonRetryableStatus: this.nonRetryableStatus,
      signal: params.signal,
      onAttempt,
      state,
      middleware: this.middleware,
      middlewareTimeoutMs: this.middlewareTimeoutMs,
      logger: this.logger,
      reportEvent: this.reportEvent,
      logLabel: 'error',
      redactText: (text) => this.redactText(text),
      countsTowardBreaker: (error) => this.countsTowardBreaker(error),
    });
  }

  /** Streaming counterpart to `run`. Mirrors the old streaming branch of `VernLLM.call`. */
  async runStream<T>(
    params: CallParams<T>,
    requestId: string,
    onAttempt?: () => void,
    state?: MiddlewareStateBag,
  ): Promise<{
    chunks: AsyncIterable<StreamChunk>;
    finalResult: Promise<T | CallWithToolsResult<T>>;
  }> {
    return runAttemptLoop({
      fn: (attempt, onRequest, resolvedState, gateway) =>
        this.executeStreamCall(params, requestId, attempt, onRequest, resolvedState, gateway),
      requestId,
      model: params.model ?? this.model,
      providerName: this.providerName,
      isFallback: this.isFallback,
      supportsJsonObjectMode: this.supportsJsonObjectMode,
      breaker: this.breaker,
      maxRetries: this.maxRetries,
      baseDelayMs: this.baseDelayMs,
      nonRetryableStatus: this.nonRetryableStatus,
      signal: params.signal,
      onAttempt,
      state,
      middleware: this.middleware,
      middlewareTimeoutMs: this.middlewareTimeoutMs,
      logger: this.logger,
      reportEvent: this.reportEvent,
      logLabel: 'stream-open error',
      redactText: (text) => this.redactText(text),
      countsTowardBreaker: (error) => this.countsTowardBreaker(error),
    });
  }

  /**
   * Performs a single attempt: builds the request (translating `tools` to
   * wire shape when present), dispatches it with a timeout, and shapes the
   * response into `T` or a `CallWithToolsResult<T>` when `params.tools` was
   * set. Throws on an empty response (no text and no tool_calls) so the
   * retry loop treats it like any other transient failure.
   */
  private async executeCall<T>(
    params: CallParams<T>,
    requestId: string,
    attempt: number,
    onRequest: OnRequest | undefined,
    middlewareState: MiddlewareStateBag | undefined,
    gateway: BreakerGateway,
  ): Promise<T | CallWithToolsResult<T>> {
    // A retry is a real request, so capacity is acquired per attempt
    // (inside the retry loop, via `executeCall` being re-invoked), not
    // once for the whole call.
    const {
      request,
      model,
      useJson,
      state,
      release: acquiredRelease,
    } = await prepareAttempt({
      params,
      requestId,
      attempt,
      onRequest,
      middlewareState,
      gateway,
      requestBuilder: this.requestBuilder,
      providerName: this.providerName,
      limiter: this.limiter,
      middleware: this.middleware,
      middlewareTimeoutMs: this.middlewareTimeoutMs,
      logger: this.logger,
      reportEvent: this.reportEvent,
    });
    let release = acquiredRelease;

    try {
      let response: Awaited<ReturnType<LLMClient['chat']['completions']['create']>>;

      try {
        response = await withTimeout(
          (attemptSignal) =>
            this.client.chat.completions.create(request, { signal: attemptSignal }),
          this.timeoutMs,
          params.signal,
        );
      } catch (error) {
        this.reactToRateLimitError(error);
        throw error;
      }

      // AIMD's proactive path. See [AIMD](/docs/core/aimd).
      this.limiter?.reactToRateLimitHint(readRateLimitHint(response));

      // Extracted right after the response arrives, before anything else
      // touches it, so a post-response failure still gets its usage reported.
      const usage = this.usageReporter.extract(response, requestId, model);
      const actualTokens = this.usageReporter.actualTokensFor(usage);

      // Raw and unvalidated on purpose. Extraction (including `.trim()`,
      // which throws on a non-string `content`) happens inside
      // `finalizeResponse`'s try/catch, so a malformed response still gets
      // normalized and its usage failure reported.
      const rawContent = response.choices?.[0]?.message?.content;
      const wireToolCalls = response.choices?.[0]?.message?.tool_calls;

      let finalized: T | CallWithToolsResult<T>;

      try {
        finalized = finalizeResponse(
          rawContent,
          wireToolCalls,
          params,
          useJson,
          usage,
          requestId,
          attempt,
          state,
          {
            gateway,
            usageReporter: this.usageReporter,
            logger: this.logger,
            redactText: (text) => this.redactText(text),
            parseJson: this.parseJson,
            detectSoftFailure: this.detectSoftFailure,
            providerName: this.providerName,
            isFallback: this.isFallback,
            model,
          },
        );
      } catch (error) {
        // Still reconcile real token usage and give the concurrency slot
        // back, but never grow the AIMD ceiling for a response VernLLM
        // itself rejected (invalid JSON, schema/tool-contract validation,
        // empty content, a soft failure): only a response that actually
        // made it back to the caller counts as a success.
        release?.(actualTokens);
        release = undefined;
        throw error;
      }

      // `success: true` is what lets AIMD grow the ceiling here, only
      // once finalization has actually succeeded. The `finally` block's
      // own `release?.()` below never passes it, so a failed attempt
      // only ever shrinks via `reactToRateLimitError`, never grows right
      // back.
      release?.(actualTokens, true);
      release = undefined;

      return finalized;
    } finally {
      release?.();
    }
  }

  /** Applies `redact` (if configured); otherwise returns `text` unchanged. */
  private redactText(text: string): string {
    return this.redact ? this.redact(text) : text;
  }

  /**
   * AIMD's reactive path: shrinks the ceiling on a real 429,
   * adapter-agnostic, independent of `supportsWithResponse`. See
   * [AIMD](/docs/core/aimd).
   */
  private reactToRateLimitError(error: unknown): void {
    if (!this.limiter) return;
    if (extractStatus(error) !== 429) return;

    this.limiter.signalRateLimit();
  }

  /**
   * Opens a stream for a single attempt: builds the request exactly like
   * `executeCall`, then requires `createStream` on the client (a clear
   * `validation` error if the adapter doesn't support it). The timeout
   * wraps stream construction and the first `.next()` together, not just
   * construction: calling an `async function*` returns an iterator
   * synchronously without running its body until `.next()` is first
   * invoked, so timing only construction would time an operation that's
   * always instant, not the actual connection. Both are folded into a
   * single `withTimeout` so the same abort signal reaches whatever the
   * adapter's `createStream` uses internally for its first network
   * round-trip.
   *
   * Circuit-breaker success is recorded once the stream fully completes,
   * not on the first chunk arriving, so a connection that opens but then
   * dies mid-stream isn't masked as a success (see `buildStreamResult`).
   */
  private async executeStreamCall<T>(
    params: CallParams<T>,
    requestId: string,
    attempt: number,
    onRequest: OnRequest | undefined,
    middlewareState: MiddlewareStateBag | undefined,
    gateway: BreakerGateway,
  ): Promise<{
    chunks: AsyncIterable<StreamChunk>;
    finalResult: Promise<T | CallWithToolsResult<T>>;
  }> {
    // A stream holds a real connection for its whole life, so its
    // capacity is released on completion (in `buildStreamResult`), not
    // once opening succeeds.
    const completions = this.client.chat.completions;

    if (!completions.createStream) {
      throw new LLMError(
        'stream: true requires a client/adapter with createStream',
        'invalid_params',
        {
          code: 'unsupported_capability',
          issues: { capability: 'createStream' },
        },
      );
    }

    const createStream = completions.createStream.bind(completions);

    const {
      request,
      model,
      useJson,
      state,
      release: acquiredRelease,
    } = await prepareAttempt({
      params,
      requestId,
      attempt,
      onRequest,
      middlewareState,
      gateway,
      requestBuilder: this.requestBuilder,
      providerName: this.providerName,
      limiter: this.limiter,
      middleware: this.middleware,
      middlewareTimeoutMs: this.middlewareTimeoutMs,
      logger: this.logger,
      reportEvent: this.reportEvent,
    });
    let release = acquiredRelease;

    // One controller for the entire stream, not just opening it. Adapters
    // already thread this signal into their transport for the life of the
    // request (that's how user-initiated cancellation works today), so
    // reusing it for the idle timeout means the same abort() call that
    // fires when the stream goes idle mid-way also tears down the
    // underlying connection, instead of only rejecting VernLLM's own
    // promise while the transport stays open.
    const streamController = new AbortController();
    const combinedExternal = params.signal
      ? AbortSignal.any([params.signal, streamController.signal])
      : streamController.signal;

    try {
      const { iterator, first } = await (async () => {
        try {
          return await withTimeout(
            async (attemptSignal) => {
              const streamIterator = createStream(request, { signal: attemptSignal })[
                Symbol.asyncIterator
              ]();
              const firstResult = await streamIterator.next();

              return { iterator: streamIterator, first: firstResult };
            },
            this.timeoutMs,
            combinedExternal,
          );
        } catch (error) {
          this.reactToRateLimitError(error);
          throw error;
        }
      })();

      // An immediately-exhausted stream (no chunks at all) is the streaming
      // equivalent of `executeCall`'s empty-response check: surface the same
      // `LLMError('Empty LLM response', 'api')` so retry behaves identically
      // whether the empty result came from a non-streaming or streaming
      // attempt.
      if (first.done) {
        throw new LLMError('Empty LLM response', 'api');
      }

      // Snapshotted before the closures below are created, since `release`
      // (the outer variable) is reassigned to undefined right after this
      // call to hand ownership off. The callbacks only run later, once the
      // stream completes, so closing over the mutable variable itself
      // would see that later `undefined` instead of the value being
      // handed off.
      const releaseAtOpen = release;

      const result = buildStreamResult(iterator, first, {
        requestId,
        model,
        providerName: this.providerName,
        isFallback: this.isFallback,
        chunkIdleTimeoutMs: params.chunkIdleTimeoutMs ?? this.chunkIdleTimeoutMs,
        streamController,
        logger: this.logger,
        signal: params.signal,
        onStreamSuccess: (_usage) => {
          // No breaker success recorded here, and no release here
          // either. `finalize`, below, is the single source of truth
          // for a streaming success, exactly like the non-streaming
          // path: releasing (and possibly growing the AIMD ceiling)
          // here, before finalize runs, would treat the attempt as
          // successful even when finalize's own shaping or
          // detectSoftFailure check is about to reject it, and would
          // reset consecutiveFailures right before the failure path
          // below tries to increment it.
        },
        onStreamFailure: (normalized, usage) => {
          // Idle timeout is the one mid-stream failure that trips the
          // breaker: otherwise a provider that hangs after one chunk
          // would always record a success and never open it.
          if (normalized.type === 'timeout') {
            gateway.recordFailure(attempt, params.signal, state, normalized.code);
          }

          if (usage && normalized.type !== 'aborted') {
            this.usageReporter.reportFailure(usage, normalized, attempt, true);
          }

          releaseAtOpen?.(this.usageReporter.actualTokensFor(usage));
        },
        finalize: (textAcc, wireToolCalls, usage) => {
          const actualTokens = this.usageReporter.actualTokensFor(usage);

          try {
            const finalized = finalizeResponse(
              textAcc,
              wireToolCalls,
              params,
              useJson,
              usage,
              requestId,
              attempt,
              state,
              {
                gateway,
                usageReporter: this.usageReporter,
                logger: this.logger,
                redactText: (text) => this.redactText(text),
                parseJson: this.parseJson,
                detectSoftFailure: this.detectSoftFailure,
                providerName: this.providerName,
                isFallback: this.isFallback,
                model,
              },
            );

            // Only now, once finalization has actually succeeded, is
            // this attempt a real success: release and let AIMD grow
            // the ceiling. See `onStreamSuccess`'s own comment for why
            // this can't happen any earlier.
            releaseAtOpen?.(actualTokens, true);

            return finalized;
          } catch (error) {
            // Still reconcile real token usage and give the
            // concurrency slot back, but never grow the AIMD ceiling
            // for a response VernLLM itself rejected (invalid JSON,
            // schema/tool-contract validation, empty content, a soft
            // failure).
            releaseAtOpen?.(actualTokens);

            // This attempt already returned successfully to the retry
            // loop once the stream opened, so unlike the non-streaming
            // path, nothing else will ever record a finalize-time
            // failure (including a soft failure) against the breaker.
            // Recorded here directly, gated by the same
            // countsTowardBreaker policy the non-streaming path already
            // applies, so this doesn't count anything that policy would
            // otherwise exclude.
            if (error instanceof LLMError && this.countsTowardBreaker(error)) {
              gateway.recordFailure(attempt, params.signal, state, error.code);
            }

            throw error;
          }
        },
      });

      // Ownership of `release` passes to `buildStreamResult` from here.
      release = undefined;

      return result;
    } finally {
      // Only reached if opening the stream itself threw; a successful
      // open hands `release` off above and leaves this a no-op.
      release?.();
    }
  }

  /**
   * Decides whether a failed attempt should count toward the circuit
   * breaker's failure threshold. A model hallucinating a tool name,
   * reusing a call id, or a provider ignoring `toolChoice: 'none'` isn't
   * the provider being unhealthy, it's a model/provider response defect
   * that will very likely recur regardless of provider health, so it
   * shouldn't push a healthy provider's circuit toward opening. Same for
   * a caller-input bug or a local rate-limit rejection: neither ever
   * reached the provider at all. A `quota_exceeded` rejection is also
   * excluded: it's a caller/account level limit, not a signal about
   * provider health, even though it's still retryable. This defers
   * directly to `LLMError.countsTowardBreaker`, which captures both
   * exclusions.
   */
  private countsTowardBreaker(error: LLMError): boolean {
    return error.countsTowardBreaker;
  }
}
