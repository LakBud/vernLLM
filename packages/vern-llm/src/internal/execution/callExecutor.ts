import { type RetryBudget } from '../retryBudget.js';
import { resolveAdapterInfo } from '../utils/adapterInfo.utils.js';
import {
  makeEventReporter,
  reportRejection,
} from '../utils/circuit-breaker/circuitBreaker.utils.js';
import {
  runPrepare,
  type PreparableBreaker,
} from '../utils/circuit-breaker/prepareBreaker.utils.js';
import { callHookSafely } from '../utils/logger.utils.js';
import {
  countsTowardBreaker,
  redactText,
  type AttemptEnvironment,
} from './attempt/attemptEnvironment.js';
import { executeCall } from './attempt/nonStreamAttempt.js';
import { executeStreamCall } from './attempt/streamAttempt.js';
import { RequestBuilder } from './requestBuilder.js';
import { createUsageReporter } from './usageReporter.js';
import { type OnRequest } from './utils/dispatch/attemptDispatch.utils.js';
import { runAttemptLoop, type RunAttemptLoopParams } from './utils/dispatch/attemptLoop.utils.js';
import {
  DEFAULT_MIDDLEWARE_TIMEOUT_MS,
  buildDispatchHooks,
  emitEvent,
} from './utils/middleware/middleware.utils.js';
import { defaultParseJson } from './utils/parse.utils.js';
import { normalizeMaxRetries, validateMaxRetryAfterMs } from './utils/retry/retry.utils.js';

import type { CircuitBreakerAdapter, CircuitBreakerCallContext } from '../../circuitBreaker.js';
import type { Logger } from '../../logger.js';
import type { RateLimiterAdapter } from '../../rateLimit.js';
import type { LLMError } from '../../types/errors.js';
import type {
  AdapterInfo,
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
  /** See `VernLLMOptions.readerStallTimeoutMs`. Off when omitted. */
  readerStallTimeoutMs?: number;
  baseDelayMs: number;
  /** See `VernLLMOptions.maxRetryAfterMs`. */
  maxRetryAfterMs: number;
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
  breaker?: CircuitBreakerAdapter;
  /** Caps retries against this target independent of `breaker`. See `VernLLMOptions.retryBudget`. */
  budget?: RetryBudget;
  limiter?: RateLimiterAdapter;
  /** True for every target after the primary. Stamped onto reported `TokenUsage`. */
  isFallback?: boolean;
  /** See `VernLLMOptions.middleware`. */
  middleware?: VernLLMMiddleware[];
  /**
   * `wrap` nesting order (`position` applied), which `dispatch` hooks nest
   * in too. Defaults to `middleware`'s order.
   */
  dispatchOrder?: VernLLMMiddleware[];
  /** See `VernLLMOptions.middlewareTimeoutMs`. */
  middlewareTimeoutMs?: number;
  /** See `VernLLMOptions.detectSoftFailure`. */
  detectSoftFailure?: DetectSoftFailure;
}

/**
 * One provider target: request building, retries, and its own breaker and limiter. `VernLLM` holds
 * one per target and adds fallback and caching on top.
 */
export class CallExecutor {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly nonRetryableStatus: number[];
  private readonly logger: Logger;
  private readonly breaker?: CircuitBreakerAdapter;
  private readonly budget?: RetryBudget;
  private readonly limiter?: RateLimiterAdapter;
  private readonly isFallback: boolean;
  private readonly supportsJsonObjectMode: boolean;
  /** Everything a single attempt reads. Shared by both attempt paths. */
  private readonly env: AttemptEnvironment;
  /** See `AttemptContext.adapter`. */
  readonly adapter: AdapterInfo;

  constructor(
    readonly providerName: string,
    client: LLMClient,
    readonly model: string,
    options: CallExecutorOptions,
  ) {
    this.maxRetries = normalizeMaxRetries(options.maxRetries);
    this.baseDelayMs = options.baseDelayMs;
    const maxRetryAfterMs = validateMaxRetryAfterMs(options.maxRetryAfterMs, providerName);
    this.nonRetryableStatus = options.nonRetryableStatus;
    this.logger = options.logger;

    if (this.maxRetries !== options.maxRetries) {
      this.logger.warn(
        `[VernLLM] ${providerName}: maxRetries must be a non-negative whole number, got ${String(options.maxRetries)}. Using ${this.maxRetries}.`,
      );
    }

    const reportEvent = makeEventReporter(options.onEvent, this.logger, {
      onUsage: options.onUsage,
      onUsageFailure: options.onUsageFailure,
    });

    this.breaker = options.breaker;
    this.budget = options.budget;
    this.limiter = options.limiter;
    this.isFallback = options.isFallback ?? false;
    const middleware = options.middleware ?? [];
    const dispatchHooks = buildDispatchHooks(middleware, options.dispatchOrder);
    this.adapter = resolveAdapterInfo(client);
    callHookSafely(this.logger, 'client.setLogger', () => client.setLogger?.(this.logger));
    const middlewareTimeoutMs = options.middlewareTimeoutMs ?? DEFAULT_MIDDLEWARE_TIMEOUT_MS;
    this.supportsJsonObjectMode = client.supportsJsonObjectMode ?? true;

    const usageReporter = createUsageReporter({
      providerName,
      isFallback: this.isFallback,
      maxRetries: this.maxRetries,
      cacheReadsCountTowardRateLimit: client.cacheReadsCountTowardRateLimit,
      emitEvent: (event, ctx) =>
        emitEvent(event, ctx, reportEvent, middleware, middlewareTimeoutMs, this.logger),
      logger: this.logger,
    });

    const requestBuilder = new RequestBuilder({
      model,
      defaultMaxTokens: options.defaultMaxTokens,
      defaultTemperature: options.defaultTemperature,
      defaultReasoningEffort: options.defaultReasoningEffort,
      defaultBudgetTokens: options.defaultBudgetTokens,
      supportsJsonObjectMode: this.supportsJsonObjectMode,
    });

    this.env = {
      client,
      providerName,
      isFallback: this.isFallback,
      timeoutMs: options.timeoutMs,
      chunkIdleTimeoutMs: options.chunkIdleTimeoutMs,
      readerStallTimeoutMs: options.readerStallTimeoutMs,
      maxRetryAfterMs,
      parseJson: options.parseJson ?? defaultParseJson,
      logger: this.logger,
      redact: options.redact,
      usageReporter,
      reportEvent,
      limiter: this.limiter,
      requestBuilder,
      middleware,
      dispatchHooks,
      middlewareTimeoutMs,
      detectSoftFailure: options.detectSoftFailure,
    };
  }

  /**
   * This target's wire request for `params`, without dispatch or `transform`.
   * Gives `wrap` a representative request before the real one exists.
   */
  previewRequest<T>(params: CallParams<T>): { model: string; request: WireCallRequest } {
    const { model, request } = this.env.requestBuilder.build(params);
    return { model, request };
  }

  /** Whether the client supports `response_format: 'json_object'`. */
  get jsonObjectModeSupported(): boolean {
    return this.supportsJsonObjectMode;
  }

  getCircuitState(model?: string) {
    return this.breaker?.getState?.(model);
  }

  /** The breaker's `readState` if it has one, otherwise `getState`. */
  async readCircuitState(model?: string) {
    return this.breaker?.readState
      ? this.breaker.readState(model)
      : this.breaker?.getState?.(model);
  }

  getFailureBreakdown(model?: string) {
    return this.breaker?.getFailureBreakdown?.(model);
  }

  getRetryBudgetState() {
    return this.budget?.getSnapshot();
  }

  getRateLimitState() {
    return this.limiter?.getState?.();
  }

  /** The limiter's `readState` if it has one, otherwise `getState`. */
  async readRateLimitState() {
    return this.limiter?.readState ? this.limiter.readState() : this.limiter?.getState?.();
  }

  /** `false` without a breaker, or when the breaker doesn't report it. */
  get isolateByModel(): boolean {
    return this.breaker?.isolateByModel ?? false;
  }

  openCircuit(model?: string, context?: CircuitBreakerCallContext): void {
    this.breaker?.open?.(model, context);
  }

  closeCircuit(model?: string, context?: CircuitBreakerCallContext): void {
    this.breaker?.close?.(model, context);
  }

  /**
   * Throws if the breaker is open. May claim a half-open trial, so it runs
   * once per logical call, from `VernLLM` or the fallback chain, never from
   * `run`. Returns a promise only when the breaker has a `prepare`, so a plain
   * breaker adds no tick.
   */
  assertBreakerClosed(model?: string, context?: CircuitBreakerCallContext): void | Promise<void> {
    const breaker = this.breaker;
    const resolvedModel = model ?? this.model;

    if (!breaker?.prepare) {
      breaker?.assertClosed(resolvedModel, context);
      return;
    }

    return runPrepare(breaker as PreparableBreaker, resolvedModel, context, this.logger).then(() =>
      breaker.assertClosed(resolvedModel, context),
    );
  }

  /** Gives back a trial `assertBreakerClosed` may have claimed. Idempotent. */
  releaseBreakerTrial(model?: string, context?: CircuitBreakerCallContext): void {
    // Declared `void`, but a remote adapter may return a promise anyway.
    reportRejection(
      this.logger,
      '[VernLLM] circuitBreaker.releaseTrial rejected',
      this.breaker?.releaseTrial?.(model ?? this.model, context),
    );
  }

  /** One logical call against this target, with retries. The breaker check stays with the caller. */
  async run<T>(
    params: CallParams<T>,
    requestId: string,
    onAttempt?: () => void,
    state?: MiddlewareStateBag,
  ): Promise<T | CallWithToolsResult<T>> {
    return runAttemptLoop(
      this.attemptLoopParams(
        params,
        requestId,
        onAttempt,
        state,
        'error',
        (attempt, onRequest, middlewareState, gateway) =>
          executeCall(this.env, {
            params,
            requestId,
            attempt,
            onRequest,
            middlewareState,
            gateway,
          }),
      ),
    );
  }

  /**
   * Streaming counterpart to `run`. `onOpened` fires when any attempt's stream
   * opens, a ping included. See `executeLogicalStreamCall`.
   */
  async runStream<T>(
    params: CallParams<T>,
    requestId: string,
    onAttempt?: () => void,
    state?: MiddlewareStateBag,
    onOpened?: () => void,
  ): Promise<{
    chunks: AsyncIterable<StreamChunk>;
    finalResult: Promise<T | CallWithToolsResult<T>>;
  }> {
    return runAttemptLoop(
      this.attemptLoopParams(
        params,
        requestId,
        onAttempt,
        state,
        'stream-open error',
        (attempt, onRequest, middlewareState, gateway) =>
          executeStreamCall(
            this.env,
            { params, requestId, attempt, onRequest, middlewareState, gateway },
            onOpened,
          ),
      ),
    );
  }

  private attemptLoopParams<R>(
    params: CallParams<unknown>,
    requestId: string,
    onAttempt: (() => void) | undefined,
    state: MiddlewareStateBag | undefined,
    logLabel: RunAttemptLoopParams<R>['logLabel'],
    fn: RunAttemptLoopParams<R>['fn'],
  ): RunAttemptLoopParams<R> {
    return {
      fn,
      requestId,
      model: params.model ?? this.model,
      providerName: this.providerName,
      isFallback: this.isFallback,
      supportsJsonObjectMode: this.supportsJsonObjectMode,
      adapter: this.adapter,
      breaker: this.breaker,
      budget: this.budget,
      maxRetries: this.maxRetries,
      baseDelayMs: this.baseDelayMs,
      maxRetryAfterMs: this.env.maxRetryAfterMs,
      nonRetryableStatus: this.nonRetryableStatus,
      signal: params.signal,
      onAttempt,
      state,
      middleware: this.env.middleware,
      middlewareTimeoutMs: this.env.middlewareTimeoutMs,
      logger: this.logger,
      reportEvent: this.env.reportEvent,
      logLabel,
      redactText: (text) => redactText(this.env, text),
      countsTowardBreaker,
    };
  }
}
