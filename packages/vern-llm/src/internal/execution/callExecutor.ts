import { CircuitBreaker, type CircuitBreakerCallContext } from '../../circuitBreaker.js';
import { LLMError, toRequestSnapshot, type LLMRequestSnapshot } from '../../types/errors.js';
import { createMiddlewareStateBag } from '../../types/middleware.js';
import { makeEventReporter } from '../circuitBreaker.utils.js';
import { RequestBuilder } from './requestBuilder.js';
import { buildStreamResult } from './streamAccumulator.js';
import { describeError, extractStatus, normalizeError } from './utils/errors.utils.js';
import {
  assertModelAndResponseFormatUnchanged,
  assertNoDuplicateTools,
  DEFAULT_MIDDLEWARE_TIMEOUT_MS,
  emitEvent,
  mergePatch,
  middlewareLabel,
  resolveEnabled,
  runTransform,
} from './utils/middleware.utils.js';
import { defaultParseJson } from './utils/parse.utils.js';
import {
  extractRetryAfterMs,
  getBackoffDelay,
  waitForRetry,
  withTimeout,
} from './utils/retry.utils.js';
import { parseWireToolCalls } from './utils/wire.utils.js';

import type { Logger } from '../../logger.js';
import type { RateLimiter } from '../../rateLimit.js';
import type {
  CallParams,
  CallWithToolsResult,
  LLMClient,
  MiddlewareContext,
  MiddlewareStateBag,
  RetryAttempt,
  StreamChunk,
  TokenUsage,
  ToolIssue,
  VernLLMEvent,
  VernLLMMiddleware,
  WireCallRequest,
  WireToolCall,
} from '../../types/index.js';

/**
 * `executeCall`/`executeStreamCall` call `onRequest` with a fully built
 * `LLMRequestSnapshot`, right after the outgoing payload is built and
 * before dispatch (rate limiting, `client.chat.completions.create`, etc).
 * Building the complete, cloned snapshot at this point, not later once an
 * attempt has failed, matters for two reasons: `startedAt` should mean
 * "when the attempt started", not "when the failure was handled", and
 * some adapters mutate the outgoing request object during dispatch itself
 * (e.g. `fromGemini` sets `request.config` in place inside `create()`),
 * so waiting until the catch block to snapshot could capture a payload
 * that had already changed since it was actually sent.
 */
type OnRequest = (snapshot: LLMRequestSnapshot) => void;

/**
 * Identity function with its own parameter, used only to sidestep a TS
 * quirk: a `let` reassigned solely inside a nested closure (like
 * `retryWithBackoff`'s `onRequest`) gets narrowed to `undefined` at the
 * point it was last synchronously assigned, which would otherwise make
 * `lastRequestForAttempt` read as `never` at the point it's used below.
 */
function passThroughRequestSnapshot(
  snapshot: LLMRequestSnapshot | undefined,
): LLMRequestSnapshot | undefined {
  return snapshot;
}

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
  private readonly onUsage?: (usage: TokenUsage) => void;
  private readonly onUsageFailure?: (usage: TokenUsage, error: LLMError) => void;
  private readonly reportEvent: (event: VernLLMEvent) => void;
  private readonly breaker?: CircuitBreaker;
  private readonly limiter?: RateLimiter;
  private readonly isFallback: boolean;
  private readonly requestBuilder: RequestBuilder;
  private readonly middleware: VernLLMMiddleware[];
  private readonly middlewareTimeoutMs: number;
  private readonly supportsJsonObjectMode: boolean;

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
    this.onUsage = options.onUsage;
    this.onUsageFailure = options.onUsageFailure;
    this.reportEvent = makeEventReporter(options.onEvent, this.logger);
    this.breaker = options.breaker;
    this.limiter = options.limiter;
    this.isFallback = options.isFallback ?? false;
    this.middleware = options.middleware ?? [];
    this.middlewareTimeoutMs = options.middlewareTimeoutMs ?? DEFAULT_MIDDLEWARE_TIMEOUT_MS;
    this.supportsJsonObjectMode = client.supportsJsonObjectMode ?? true;
    this.requestBuilder = new RequestBuilder({
      model,
      defaultMaxTokens: options.defaultMaxTokens,
      defaultTemperature: options.defaultTemperature,
      defaultReasoningEffort: options.defaultReasoningEffort,
      defaultBudgetTokens: options.defaultBudgetTokens,
      supportsJsonObjectMode: this.supportsJsonObjectMode,
    });
  }

  /** Builds the `MiddlewareContext` for one attempt against this target. `attempt` is 0-based here, 1-based on the result. */
  private buildEventContext(
    requestId: string,
    model: string,
    attempt: number,
    signal: AbortSignal | undefined,
    state: MiddlewareStateBag,
  ): MiddlewareContext {
    return {
      requestId,
      requestedProvider: this.providerName,
      requestedModel: model,
      isFallbackAttempt: this.isFallback,
      attempt: attempt + 1,
      capabilities: { supportsJsonObjectMode: this.supportsJsonObjectMode },
      signal,
      state,
      own: {},
    };
  }

  /**
   * Runs every applicable middleware's `transform` against `request`, in
   * priority order, merging each patch in immediately so a later
   * middleware sees what an earlier one already changed. Reports the
   * `'middleware'` trace event for each `transform` that actually
   * changed something, and for each `enabled` predicate that skipped its
   * middleware.
   */
  private async applyMiddlewareTransforms(
    request: WireCallRequest,
    requestId: string,
    model: string,
    attempt: number,
    signal: AbortSignal | undefined,
    state: MiddlewareStateBag,
  ): Promise<WireCallRequest> {
    if (this.middleware.length === 0) return request;

    const before = request;
    let current = request;

    const ordered = this.middleware
      .map((middleware, index) => ({ middleware, index }))
      .sort((a, b) => (a.middleware.priority ?? 0) - (b.middleware.priority ?? 0));

    for (const { middleware, index } of ordered) {
      const label = middlewareLabel(middleware, index);

      const ctx = this.buildEventContext(requestId, model, attempt, signal, state);

      const isEnabled = await resolveEnabled(
        middleware,
        ctx,
        label,
        this.middlewareTimeoutMs,
        this.logger,
      );

      if (!isEnabled) {
        if (middleware.enabled !== undefined) {
          emitEvent(
            { kind: 'middleware', requestId, middleware: label, hook: 'enabled_skip' },
            ctx,
            this.reportEvent,
            this.middleware,
            this.middlewareTimeoutMs,
            this.logger,
          );
        }
        continue;
      }

      if (!middleware.transform) continue;

      const patch = await runTransform(
        middleware,
        structuredClone(current),
        ctx,
        label,
        this.middlewareTimeoutMs,
      );
      const { request: merged, patchedFields } = mergePatch(current, patch);

      if (patchedFields.length > 0) {
        if (patch.tools !== undefined || patch.addTools?.length) {
          assertNoDuplicateTools(merged, label);
        }
        emitEvent(
          { kind: 'middleware', requestId, middleware: label, hook: 'transform', patchedFields },
          ctx,
          this.reportEvent,
          this.middleware,
          this.middlewareTimeoutMs,
          this.logger,
        );
      }

      current = merged;
    }

    assertModelAndResponseFormatUnchanged(before, current, 'chain');

    return current;
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
    const model = params.model ?? this.model;
    const resolvedState = state ?? createMiddlewareStateBag();
    const attempts: RetryAttempt[] = [];

    try {
      return await this.retryWithBackoff(
        (attempt, onRequest) =>
          this.executeCall(params, requestId, attempt, onRequest, resolvedState),
        requestId,
        model,
        resolvedState,
        params.signal,
        onAttempt,
        attempts,
      );
    } catch (error) {
      // `attempts` only holds prior attempts that were actually retried
      // past. It's `[]` when nothing was retried, so normalize that to
      // `undefined` per `LLMError.attempts`'s contract.
      const normalized = normalizeError(
        error,
        params.signal,
        attempts.length > 0 ? attempts : undefined,
      );

      if (this.countsTowardBreaker(normalized)) {
        this.breaker?.recordFailure(model, {
          requestId,
          state: resolvedState,
          signal: params.signal,
        });
      }

      this.logger.debug(`[VernLLM:${requestId}] error:\n${this.redactText(describeError(error))}`);

      throw normalized;
    }
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
    const model = params.model ?? this.model;
    const resolvedState = state ?? createMiddlewareStateBag();
    const attempts: RetryAttempt[] = [];

    try {
      return await this.retryWithBackoff(
        (attempt, onRequest) =>
          this.executeStreamCall(params, requestId, attempt, onRequest, resolvedState),
        requestId,
        model,
        resolvedState,
        params.signal,
        onAttempt,
        attempts,
      );
    } catch (error) {
      // See the matching comment in `run`.
      const normalized = normalizeError(
        error,
        params.signal,
        attempts.length > 0 ? attempts : undefined,
      );

      if (this.countsTowardBreaker(normalized)) {
        this.breaker?.recordFailure(model, {
          requestId,
          state: resolvedState,
          signal: params.signal,
        });
      }

      this.logger.debug(
        `[VernLLM:${requestId}] stream-open error:\n${this.redactText(describeError(error))}`,
      );

      throw normalized;
    }
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
    onRequest?: OnRequest,
    middlewareState?: MiddlewareStateBag,
  ): Promise<T | CallWithToolsResult<T>> {
    const state = middlewareState ?? createMiddlewareStateBag();
    const built = this.requestBuilder.build(params);
    const { useJson, model } = built;
    const request = await this.applyMiddlewareTransforms(
      built.request,
      requestId,
      model,
      attempt,
      params.signal,
      state,
    );

    onRequest?.(toRequestSnapshot(this.providerName, model, request, undefined, Date.now()));

    // A retry is a real request, so capacity is acquired per attempt
    // (inside the retry loop, via `executeCall` being re-invoked), not
    // once for the whole call.
    let release: ((actualTokens?: number) => void) | undefined;

    if (this.limiter) {
      const acquired = await this.limiter.acquire(this.limiter.estimate(request), params.signal);
      release = acquired.release;

      if (acquired.waitedMs > 0) {
        emitEvent(
          {
            kind: 'rate_limited',
            requestId,
            provider: this.providerName,
            model,
            waitedMs: acquired.waitedMs,
            reason: acquired.reason ?? 'rpm',
          },
          this.buildEventContext(requestId, model, attempt, params.signal, state),
          this.reportEvent,
          this.middleware,
          this.middlewareTimeoutMs,
          this.logger,
        );
      }
    }

    try {
      const response = await withTimeout(
        (attemptSignal) => this.client.chat.completions.create(request, { signal: attemptSignal }),
        this.timeoutMs,
        params.signal,
      );

      // Extracted right after the response arrives, before anything else
      // touches it, so a post-response failure still gets its usage reported.
      const usage = this.extractUsage(response, requestId, model);

      // Reconcile against real usage, then hand off so `finally` below
      // can't release a second time.
      release?.(this.actualTokensFor(usage));
      release = undefined;

      // Raw and unvalidated on purpose. Extraction (including `.trim()`,
      // which throws on a non-string `content`) happens inside
      // `finalizeResponse`'s try/catch, so a malformed response still gets
      // normalized and its usage failure reported.
      const rawContent = response.choices?.[0]?.message?.content;
      const wireToolCalls = response.choices?.[0]?.message?.tool_calls;

      return this.finalizeResponse(
        rawContent,
        wireToolCalls,
        params,
        useJson,
        model,
        usage,
        requestId,
        attempt,
        state,
      );
    } finally {
      release?.();
    }
  }

  /** Applies `redact` (if configured); otherwise returns `text` unchanged. */
  private redactText(text: string): string {
    return this.redact ? this.redact(text) : text;
  }

  /**
   * Applies `redact` (if configured) to whatever the debug log is about
   * to show: real content when there is any, otherwise the tool-call
   * placeholder, which carries no user data and passes through
   * `redact` unchanged in practice but is included for a caller whose
   * `redact` does something structural (e.g. adding a marker) rather
   * than just scrubbing PII.
   */
  private redactedOutput(
    content: string | undefined,
    wireToolCalls: WireToolCall[] | undefined,
  ): string {
    return this.redactText(content ?? `[${wireToolCalls?.length ?? 0} tool call(s)]`);
  }

  /**
   * Shapes a fully-arrived response (content and/or tool_calls, already
   * extracted from the provider's payload) into `T` or a
   * `CallWithToolsResult<T>`. Reused by the streaming path once it has
   * buffered the full text/tool-call deltas, so there's no separate
   * parsing/validation logic for streaming.
   *
   * Normalizes and reports usage failure on error itself, so every caller
   * gets identical error handling without duplicating it.
   */
  private finalizeResponse<T>(
    rawContent: string | null | undefined,
    wireToolCalls: WireToolCall[] | undefined,
    params: CallParams<T>,
    useJson: boolean,
    model: string,
    usage: TokenUsage | undefined,
    requestId: string,
    attempt: number,
    state: MiddlewareStateBag,
  ): T | CallWithToolsResult<T> {
    const breakerContext: CircuitBreakerCallContext = { requestId, state, signal: params.signal };

    try {
      // `.trim()` runs inside this try: a malformed response shape
      // (e.g. a non-string `content`) throws here and is normalized and
      // reported like any other post-response failure.
      const content = rawContent?.trim();

      if (!content && !wireToolCalls?.length) {
        throw new LLMError('Empty LLM response', 'api', { code: 'empty_response' });
      }

      this.logger.debug(
        `[VernLLM:${requestId}] output:\n${this.redactedOutput(content, wireToolCalls).slice(0, 800)}`,
      );

      if (wireToolCalls?.length) {
        if (!params.tools) {
          // Same class of problem as the other tool-contract codes below:
          // a provider contract violation, not an HTTP failure, so this is
          // `type: 'validation'` rather than `'api'`. Byte-for-byte
          // identical on retry, so not retryable.
          throw new LLMError(
            'Provider returned tool_calls but no `tools` were sent with this call.',
            'validation',
            { code: 'unexpected_tool_calls' },
          );
        }

        if (params.toolChoice === 'none') {
          // `toolChoice: 'none'` is what lets `call()`'s type narrow to
          // `ContentResult<T>` (see `ToolsDisabledCallParams`). A
          // nonconforming provider/adapter returning tool_calls anyway
          // would silently break that guarantee for the caller, so this
          // is treated as a hard API-contract violation rather than
          // passed through as a normal tool_calls result. The request
          // itself is byte-for-byte identical on retry, so this repeats
          // deterministically like the other tool-contract failures
          // below: not retryable, and not the provider being unhealthy.
          throw new LLMError(
            "Provider returned tool_calls despite toolChoice: 'none'.",
            'validation',
            {
              code: 'tool_choice_none_violated',
            },
          );
        }

        const toolCalls = parseWireToolCalls(wireToolCalls);

        this.validateToolCallArguments(toolCalls, params.tools);
        this.breaker?.recordSuccess(model, breakerContext);
        this.reportUsage(usage);

        return { type: 'tool_calls', toolCalls, ...(content ? { content } : {}) };
      }

      // No tool_calls here, so content must be present.
      const textContent = content ?? '';

      if (!useJson) {
        this.breaker?.recordSuccess(model, breakerContext);
        this.reportUsage(usage);

        return params.tools ? { type: 'content', content: textContent as T } : (textContent as T);
      }

      const result = this.parseAndValidate<T>(textContent, params.schema);
      this.breaker?.recordSuccess(model, breakerContext);
      this.reportUsage(usage);

      return params.tools ? { type: 'content', content: result } : result;
    } catch (error) {
      // Normalized first so onUsageFailure always gets a real LLMError.
      // Also covers aborted signals: normalizeError returns type
      // 'aborted' in that case.
      const normalized = normalizeError(error, params.signal);

      if (usage && normalized.type !== 'aborted') {
        this.reportUsageFailure(usage, normalized, attempt);
      }

      throw normalized;
    }
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
    onRequest?: OnRequest,
    middlewareState?: MiddlewareStateBag,
  ): Promise<{
    chunks: AsyncIterable<StreamChunk>;
    finalResult: Promise<T | CallWithToolsResult<T>>;
  }> {
    const state = middlewareState ?? createMiddlewareStateBag();
    const built = this.requestBuilder.build(params);
    const { useJson, model } = built;
    const request = await this.applyMiddlewareTransforms(
      built.request,
      requestId,
      model,
      attempt,
      params.signal,
      state,
    );

    onRequest?.(toRequestSnapshot(this.providerName, model, request, undefined, Date.now()));

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

    // A stream holds a real connection for its whole life, so its
    // capacity is released on completion (in `buildStreamResult`), not
    // once opening succeeds.
    let release: ((actualTokens?: number) => void) | undefined;

    if (this.limiter) {
      const acquired = await this.limiter.acquire(this.limiter.estimate(request), params.signal);
      release = acquired.release;

      if (acquired.waitedMs > 0) {
        emitEvent(
          {
            kind: 'rate_limited',
            requestId,
            provider: this.providerName,
            model,
            waitedMs: acquired.waitedMs,
            reason: acquired.reason ?? 'rpm',
          },
          this.buildEventContext(requestId, model, attempt, params.signal, state),
          this.reportEvent,
          this.middleware,
          this.middlewareTimeoutMs,
          this.logger,
        );
      }
    }

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
      const { iterator, first } = await withTimeout(
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
        onStreamSuccess: (usage) => {
          this.breaker?.recordSuccess(model, { requestId, state, signal: params.signal });
          releaseAtOpen?.(this.actualTokensFor(usage));
        },
        onStreamFailure: (normalized, usage) => {
          // Idle timeout is the one mid-stream failure that trips the
          // breaker: otherwise a provider that hangs after one chunk
          // would always record a success and never open it.
          if (normalized.type === 'timeout') {
            this.breaker?.recordFailure(model, { requestId, state, signal: params.signal });
          }

          if (usage && normalized.type !== 'aborted') {
            this.reportUsageFailure(usage, normalized, attempt, true);
          }

          releaseAtOpen?.(this.actualTokensFor(usage));
        },
        finalize: (textAcc, wireToolCalls, usage) =>
          this.finalizeResponse(
            textAcc,
            wireToolCalls,
            params,
            useJson,
            model,
            usage,
            requestId,
            attempt,
            state,
          ),
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
   * Checks every `ToolCall` against the `tools` that were offered, catching
   * a hallucinated tool name and a duplicate call id before either reaches
   * the application's dispatch table, then runs each tool's
   * `argumentsSchema`, if present.
   *
   * Contract failures (unknown name, duplicate id) are collected across
   * every call and thrown together as one `type: 'validation'` error with
   * `issues: ToolIssue[]`, since retrying a request that already has these
   * errors cannot help (excluded from retry by `type`) and a caller fixing
   * them wants to see every one, not just the first. Schema failures keep
   * the original single-error, `type: 'validation'` shape rather than being
   * folded into the aggregate, since they're a distinct failure kind from
   * the contract failures above.
   */
  private validateToolCallArguments(
    toolCalls: { id: string; name: string; arguments: unknown }[],
    tools: NonNullable<CallParams<unknown>['tools']>,
  ): void {
    const known = new Map(tools.map((t) => [t.name, t]));
    const seenIds = new Set<string>();
    const toolIssues: ToolIssue[] = [];

    for (const call of toolCalls) {
      if (seenIds.has(call.id)) {
        toolIssues.push({ name: call.name, toolCallId: call.id, code: 'duplicate_tool_call_id' });
      }
      seenIds.add(call.id);

      if (!known.has(call.name)) {
        toolIssues.push({ name: call.name, toolCallId: call.id, code: 'unknown_tool' });
      }
    }

    if (toolIssues.length > 0) {
      const unknownTool = toolIssues.find((i) => i.code === 'unknown_tool');
      const primary = unknownTool
        ? `Model requested tool "${unknownTool.name}", which was not in the tools offered ([${[...known.keys()].join(', ')}]).`
        : `Duplicate tool call id "${toolIssues[0]!.toolCallId}" in the model's response.`;

      // Most responses hit exactly one issue. When there's more than one,
      // say so, since toolCalls[0]'s problem alone would otherwise read as
      // the whole story.
      const message =
        toolIssues.length > 1
          ? `${primary} (${toolIssues.length} tool call issues total, see error.issues.)`
          : primary;

      throw new LLMError(message, 'validation', {
        code: unknownTool ? 'unknown_tool' : 'duplicate_tool_call_id',
        issues: toolIssues,
      });
    }

    for (const call of toolCalls) {
      const definition = known.get(call.name);

      if (!definition?.argumentsSchema) continue;

      const result = definition.argumentsSchema.safeParse(call.arguments);

      if (!result.success) {
        throw new LLMError(
          `Arguments for tool call "${call.name}" failed validation`,
          'validation',
          {
            issues: result.error,
          },
        );
      }
    }
  }

  /**
   * Runs `fn`, retrying with backoff according to `shouldRetry`. When
   * `attempts` is given, every failed attempt that is actually followed by
   * a retry is recorded, in order. This mirrors `LLMError.attempts`'s
   * contract: every attempt made before this error was thrown. The
   * terminal failure is never pushed since it isn't a prior attempt, it
   * is the error being thrown. `attempts` stays empty when nothing was
   * retried, so no separate bookkeeping is needed at the call sites.
   * Each failure is recorded as a snapshot (`LLMError.toSnapshot()`),
   * not the live `LLMError`, per `RetryAttempt`'s contract.
   */
  private async retryWithBackoff<T>(
    fn: (attempt: number, onRequest: OnRequest) => Promise<T>,
    requestId: string,
    model: string,
    state: MiddlewareStateBag,
    signal?: AbortSignal,
    onAttempt?: () => void,
    attempts?: RetryAttempt[],
  ): Promise<T> {
    let lastError: unknown;
    let lastRequestForAttempt: LLMRequestSnapshot | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Reset before this iteration's own onRequest can run. If this
      // attempt fails before onRequest is ever called (e.g. thrown by
      // recoverDelay or onAttempt, before fn/onRequest runs), the
      // previous attempt's request must not be misattributed to this
      // attempt's index below.
      lastRequestForAttempt = undefined;

      try {
        if (attempt > 0) {
          await this.recoverDelay(requestId, model, attempt, lastError, state, signal);
        }

        onAttempt?.();
        return await fn(attempt, (req) => {
          lastRequestForAttempt = req;
        });
      } catch (error) {
        lastError = error;

        const willRetry = attempt < this.maxRetries && this.shouldRetry(error, signal);
        if (!willRetry) break;

        attempts?.push({
          index: attempt,
          error: normalizeError(error, signal).toSnapshot(),
          request: passThroughRequestSnapshot(lastRequestForAttempt),
        });
      }
    }

    throw lastError;
  }

  /**
   * Pulls `TokenUsage` out of a raw response, if the provider reported it.
   * Extraction doesn't depend on what happens to the response afterward, so
   * a malformed body can still yield usage if the provider's usage block
   * itself came through intact.
   */
  private extractUsage(
    response: Awaited<ReturnType<LLMClient['chat']['completions']['create']>>,
    requestId: string,
    model: string,
  ): TokenUsage | undefined {
    if (!response.usage) return undefined;

    const reasoningTokens = response.usage.completion_tokens_details?.reasoning_tokens;

    return {
      promptTokens: response.usage.prompt_tokens ?? 0,
      completionTokens: response.usage.completion_tokens ?? 0,
      totalTokens: response.usage.total_tokens ?? 0,
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      requestId,
      model,
      provider: this.providerName,
      usedFallback: this.isFallback,
    };
  }

  /**
   * The token count to reconcile the rate limiter against for a finished
   * attempt: `totalTokens` when reported, otherwise the sum of prompt and
   * completion tokens, matching `reportUsageFailure`'s own fallback below
   * for a hand-rolled client that reports the parts but omits the total.
   */
  private actualTokensFor(usage: TokenUsage | undefined): number | undefined {
    if (!usage) return undefined;
    return usage.totalTokens || usage.promptTokens + usage.completionTokens;
  }

  /** Reports token usage for a successful call, swallowing and logging any error `onUsage` throws. */
  private reportUsage(usage: TokenUsage | undefined): void {
    if (!usage || !this.onUsage) return;

    try {
      this.onUsage(usage);
    } catch (error) {
      this.logger.error('[VernLLM] onUsage failed', {
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  /**
   * Reports token usage spent on an attempt that then failed, so it isn't
   * dropped alongside the error. Covers any error thrown after usage
   * extraction, since all of them happen only after a response (real
   * spend) already arrived. Swallows and logs any error `onUsageFailure`
   * itself throws.
   */
  private reportUsageFailure(
    usage: TokenUsage,
    error: LLMError,
    attempt: number,
    terminal = false,
  ): void {
    // Falls back to promptTokens + completionTokens if totalTokens is 0
    // (e.g. a hand-rolled client that omits the total), so the log
    // doesn't understate real spend.
    const displayTokens = usage.totalTokens || usage.promptTokens + usage.completionTokens;

    // A mid-stream failure is terminal for that call (no further attempts
    // for this stream), unlike a stream-open failure where attempt N+1 may
    // still follow. Label them differently so the log doesn't imply a
    // retry that isn't coming.
    const attemptText = terminal
      ? 'mid-stream failure (terminal, no further attempts)'
      : `attempt ${attempt + 1}/${this.maxRetries + 1}`;

    this.logger.warn(
      `[VernLLM:${usage.requestId}] usage failure, ${attemptText}: ` +
        `type=${error.type} tokens=${displayTokens}`,
    );

    if (!this.onUsageFailure) return;

    try {
      this.onUsageFailure(usage, error);
    } catch (hookError) {
      this.logger.error('[VernLLM] onUsageFailure failed', {
        message: hookError instanceof Error ? hookError.message : 'unknown',
      });
    }
  }

  /** Parses response content as JSON and validates it against `schema` when supplied. */
  private parseAndValidate<T>(content: string, schema?: CallParams<T>['schema']): T {
    let parsed: unknown;

    try {
      parsed = this.parseJson(content);
    } catch {
      throw new LLMError('Invalid JSON response', 'parse');
    }

    if (parsed === null || parsed === undefined) {
      throw new LLMError('Invalid JSON response', 'parse');
    }

    if (!schema) return parsed as T;

    const result = schema.safeParse(parsed);

    if (!result.success) {
      throw new LLMError('Schema validation failed', 'validation', { issues: result.error });
    }

    return result.data;
  }

  /**
   * Waits out the backoff delay for a retry attempt, honoring a
   * Retry-After header on the failed attempt's error when present. When
   * no Retry-After is present, a rate-limited (429) response backs off
   * hardest, a server error (500 through 599) backs off somewhat more
   * than the default curve, and every other retryable failure keeps the
   * default curve. Both Retry-After and plain exponential backoff are
   * capped at the same max delay (see `DEFAULT_MAX_DELAY_MS` in
   * `retry.utils.ts`).
   */
  private async recoverDelay(
    requestId: string,
    model: string,
    attempt: number,
    error: unknown,
    state: MiddlewareStateBag,
    signal?: AbortSignal,
  ) {
    const retryAfterMs = extractRetryAfterMs(error);
    const status = extractStatus(error);
    const delay =
      retryAfterMs ??
      getBackoffDelay(
        this.baseDelayMs,
        attempt,
        undefined,
        status === 429,
        status !== undefined && status >= 500 && status <= 599,
      );
    const retryAfterHonored = retryAfterMs !== undefined;

    this.logger.warn(
      `[VernLLM:${requestId}] recovery attempt ${attempt}/${this.maxRetries}, waiting ${Math.ceil(delay)}ms` +
        (retryAfterHonored ? ' (honoring Retry-After)' : ''),
    );

    emitEvent(
      {
        kind: 'retry',
        requestId,
        provider: this.providerName,
        model,
        attempt,
        maxRetries: this.maxRetries,
        delayMs: delay,
        retryAfterHonored,
        error: normalizeError(error, signal),
      },
      this.buildEventContext(requestId, model, attempt, signal, state),
      this.reportEvent,
      this.middleware,
      this.middlewareTimeoutMs,
      this.logger,
    );

    await waitForRetry(delay, signal);
  }

  /** Decides whether a failed attempt is worth retrying. */
  private shouldRetry(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return false;

    // `LLMError.retryable` already covers the deterministic cases: parse/
    // validation/invalid_params/aborted types, the tool contract codes,
    // and the local rate-limit codes. Only `nonRetryableStatus`, specific
    // to this call, isn't part of that general-purpose property.
    if (error instanceof LLMError && !error.retryable) return false;

    const status = extractStatus(error);

    return !(status !== undefined && this.nonRetryableStatus.includes(status));
  }

  /**
   * Decides whether a failed attempt should count toward the circuit
   * breaker's failure threshold. A model hallucinating a tool name,
   * reusing a call id, or a provider ignoring `toolChoice: 'none'` isn't
   * the provider being unhealthy, it's a model/provider response defect
   * that will very likely recur regardless of provider health, so it
   * shouldn't push a healthy provider's circuit toward opening. Same for
   * a caller-input bug or a local rate-limit rejection: neither ever
   * reached the provider at all. This is exactly what `LLMError.retryable`
   * already excludes, so this defers to it directly.
   */
  private countsTowardBreaker(error: LLMError): boolean {
    return error.retryable;
  }
}
