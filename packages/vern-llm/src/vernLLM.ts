import { CacheOrchestrator } from './internal/cache/cacheOrchestrator.js';
import { claimMetaHolder, type MetaHolder } from './internal/cache/utils/metaHolder.utils.js';
import { CallExecutor } from './internal/execution/callExecutor.js';
import { type LogicalCallDependencies } from './internal/execution/logicalCall.js';
import { runReservedLogicalCall } from './internal/execution/reservedLogicalCall.js';
import { runOperation, type RunOperationDependencies } from './internal/execution/runOperation.js';
import { combineSignals, setupCallSignal } from './internal/execution/utils/callSignal.utils.js';
import { setupDeadline, stampDeadlineCode } from './internal/execution/utils/deadline.utils.js';
import { DEFAULT_MIDDLEWARE_TIMEOUT_MS } from './internal/execution/utils/middleware/middleware.utils.js';
import { buildExecutors } from './internal/executorFactory.js';
import { buildMiddlewarePipeline } from './internal/resolveMiddlewareOrder.js';
import { buildCache } from './internal/utils/cache/cacheAdapter.utils.js';
import {
  makeEventReporter,
  resolveExecutor,
  warnIfModelUnsupported,
} from './internal/utils/circuit-breaker/circuitBreaker.utils.js';
import { createSafeLogger, logError, NoopLogger } from './internal/utils/logger.utils.js';
import { ConsoleLogger, type Logger } from './logger.js';
import {
  LLMError,
  defaultFallbackOn,
  type CachedCallParams,
  type CachedStreamCallParams,
  type CachedStreamConditionalToolCallParams,
  type CachedStreamConditionalStringToolCallParams,
  type CachedStreamToolCallParams,
  type CachedConditionalToolCallParams,
  type CachedConditionalStringToolCallParams,
  type CachedToolCallParams,
  type CachedJsonModeDisabledCallParams,
  type CachedJsonModeEnabledCallParams,
  type CallParams,
  type CallWithToolsResult,
  type ConditionalToolCallParams,
  type ConditionalStringToolCallParams,
  type ContentResult,
  type FallbackTarget,
  type JsonModeDisabledCallParams,
  type JsonModeEnabledCallParams,
  type JsonValue,
  type LLMErrorCode,
  type StreamCallResult,
  type StreamConditionalStringToolCallParams,
  type StreamEnabledCallParams,
  type StreamJsonModeDisabledCallParams,
  type StreamJsonModeEnabledCallParams,
  type CachedStreamJsonModeDisabledCallParams,
  type CachedStreamJsonModeEnabledCallParams,
  type TargetCircuitState,
  type CircuitTarget,
  type ToolDefinition,
  type ToolEnabledCallParams,
  type ToolsDisabledCallParams,
  type VernLLMOptions,
} from './types/index.js';
import { createMiddlewareStateBag, type MiddlewareStateBag } from './types/middleware.js';

import type { CircuitState } from './circuitBreaker.js';
import type { InternalCacheParams } from './internal/cache/utils/cache.utils.js';
import type { RateLimitState } from './rateLimit.js';

/**
 * The LLM call framework: retries, timeouts, circuit breaking, fallback, rate limiting, caching and
 * middleware around any provider adapter.
 */
export class VernLLM {
  private readonly logger: Logger;

  /** One per target: index 0 is the primary, then each fallback in declared order. */
  private readonly executors: CallExecutor[];

  /** Owns cache reads, writes and in-flight coalescing for `cachedCall()`. */
  private readonly cacheOrchestrator: CacheOrchestrator;

  private readonly logicalCallDependencies: LogicalCallDependencies;
  private readonly runOperationDependencies: RunOperationDependencies;

  /**
   * Marks `cachedCall()`'s inner call params with its state bag, so the inner
   * `runOperation` skips `wrap` and reuses that bag. Keyed by object identity,
   * since concurrent `cachedCall()`s can share an explicit `requestId`.
   */
  private readonly cachedCallInnerParams = new WeakMap<CallParams<unknown>, MiddlewareStateBag>();

  /** Shared `CallMeta` holders per resolved cache key. See `claimMetaHolder`. */
  private readonly cachedCallMeta = new Map<string, MetaHolder>();

  /** @param options Client, model and tunables. See `VernLLMOptions` for each default. */
  constructor(options: VernLLMOptions) {
    this.logger = createSafeLogger(
      options.logger === 'silent'
        ? new NoopLogger()
        : (options.logger ?? new ConsoleLogger(options.debug ?? false)),
    );

    const providerName = options.name ?? 'primary';

    this.cacheOrchestrator = new CacheOrchestrator(buildCache(options.cache), this.logger);

    const reportEvent = makeEventReporter(options.onEvent, this.logger);
    const pipeline = buildMiddlewarePipeline(options.middleware ?? [], this.logger);
    const middlewareTimeoutMs = options.middlewareTimeoutMs ?? DEFAULT_MIDDLEWARE_TIMEOUT_MS;

    // The primary target's shared knobs, resolved once here rather than
    // inline in the retry-tunable default below, since fallback targets
    // that omit a field inherit this resolved value, not the raw
    // (possibly-undefined) option.
    const primaryDefaultTemperature =
      options.defaultTemperature === undefined ? 0.2 : options.defaultTemperature;
    const primaryDefaultReasoningEffort = options.defaultReasoningEffort;
    const primaryDefaultBudgetTokens = options.defaultBudgetTokens;

    // The primary, shaped as a `FallbackTarget` so it goes through the same build loop. Fallback
    // targets never inherit its breaker or limiter.
    const primaryTarget: FallbackTarget = {
      client: options.client,
      model: options.model,
      name: providerName,
      maxRetries: options.maxRetries,
      timeoutMs: options.timeoutMs,
      chunkIdleTimeoutMs: options.chunkIdleTimeoutMs,
      readerStallTimeoutMs: options.readerStallTimeoutMs,
      baseDelayMs: options.baseDelayMs,
      maxRetryAfterMs: options.maxRetryAfterMs,
      defaultMaxTokens: options.defaultMaxTokens,
      defaultTemperature: primaryDefaultTemperature,
      defaultReasoningEffort: primaryDefaultReasoningEffort,
      defaultBudgetTokens: primaryDefaultBudgetTokens,
      nonRetryableStatus: options.nonRetryableStatus,
      circuitBreaker: options.circuitBreaker,
      rateLimit: options.rateLimit,
      retryBudget: options.retryBudget,
      detectSoftFailure: options.detectSoftFailure,
    };

    const declaredFallbacks: FallbackTarget[] = Array.isArray(options.fallback)
      ? options.fallback
      : options.fallback
        ? [options.fallback]
        : [];

    this.executors = buildExecutors(primaryTarget, declaredFallbacks, {
      providerName,
      primaryDefaultTemperature,
      primaryDefaultReasoningEffort,
      primaryDefaultBudgetTokens,
      maxRetries: options.maxRetries,
      timeoutMs: options.timeoutMs,
      chunkIdleTimeoutMs: options.chunkIdleTimeoutMs,
      readerStallTimeoutMs: options.readerStallTimeoutMs,
      baseDelayMs: options.baseDelayMs,
      maxRetryAfterMs: options.maxRetryAfterMs,
      defaultMaxTokens: options.defaultMaxTokens,
      nonRetryableStatus: options.nonRetryableStatus,
      parseJson: options.parseJson,
      redact: options.redact,
      onUsage: options.onUsage,
      onUsageFailure: options.onUsageFailure,
      onEvent: options.onEvent,
      logger: this.logger,
      middleware: pipeline.transformOrder,
      dispatchOrder: pipeline.wrapOrder,
      middlewareTimeoutMs,
      detectSoftFailure: options.detectSoftFailure,
    });

    this.logicalCallDependencies = {
      executors: this.executors,
      fallbackOn: options.fallbackOn ?? defaultFallbackOn,
      reportEvent,
      middleware: pipeline.transformOrder,
      middlewareTimeoutMs,
      logger: this.logger,
    };
    this.runOperationDependencies = {
      pipeline,
      primaryExecutor: this.executors[0]!,
      middlewareTimeoutMs,
      logger: this.logger,
      reportEvent,
    };
  }

  /**
   * Makes one logical call, with retries, fallback and the breaker applied. Rejects with a
   * normalized `LLMError`. See the Tool Calling and Streaming docs for the return shapes.
   *
   * @param params Content plus per call overrides. See `CallParams`.
   * @returns The parsed response, a `CallWithToolsResult<T>` with `tools`, or a `StreamCallResult`
   * with `stream: true`.
   */
  async call<T = unknown, const Tools extends readonly ToolDefinition[] = ToolDefinition[]>(
    params: StreamEnabledCallParams<T, Tools> & ToolsDisabledCallParams<T, Tools>,
  ): Promise<StreamCallResult<ContentResult<T>>>;

  async call<T = unknown, const Tools extends readonly ToolDefinition[] = ToolDefinition[]>(
    params: StreamEnabledCallParams<T, Tools> & ToolEnabledCallParams<T, Tools>,
  ): Promise<StreamCallResult<CallWithToolsResult<T, Tools>>>;

  async call<const Tools extends readonly ToolDefinition[] = ToolDefinition[]>(
    params: StreamConditionalStringToolCallParams<Tools>,
  ): Promise<StreamCallResult<string | CallWithToolsResult<string, Tools>>>;

  async call<T = unknown, const Tools extends readonly ToolDefinition[] = ToolDefinition[]>(
    params: StreamEnabledCallParams<T, Tools> & ConditionalToolCallParams<T, Tools>,
  ): Promise<StreamCallResult<T | CallWithToolsResult<T, Tools>>>;

  async call(params: StreamJsonModeDisabledCallParams): Promise<StreamCallResult<string>>;

  async call(params: StreamJsonModeEnabledCallParams): Promise<StreamCallResult<JsonValue>>;

  async call<T = unknown>(params: StreamEnabledCallParams<T>): Promise<StreamCallResult<T>>;

  async call<T = unknown, const Tools extends readonly ToolDefinition[] = ToolDefinition[]>(
    params: ToolsDisabledCallParams<T, Tools>,
  ): Promise<ContentResult<T>>;

  async call<T = unknown, const Tools extends readonly ToolDefinition[] = ToolDefinition[]>(
    params: ToolEnabledCallParams<T, Tools>,
  ): Promise<CallWithToolsResult<T, Tools>>;

  async call<const Tools extends readonly ToolDefinition[] = ToolDefinition[]>(
    params: ConditionalStringToolCallParams<Tools>,
  ): Promise<string | CallWithToolsResult<string, Tools>>;

  async call<T = unknown, const Tools extends readonly ToolDefinition[] = ToolDefinition[]>(
    params: ConditionalToolCallParams<T, Tools>,
  ): Promise<T | CallWithToolsResult<T, Tools>>;

  async call(params: JsonModeDisabledCallParams): Promise<string>;

  async call(params: JsonModeEnabledCallParams): Promise<JsonValue>;

  async call<T = unknown>(params: CallParams<T>): Promise<T>;

  async call<T = unknown>(
    params: CallParams<T>,
  ): Promise<T | CallWithToolsResult<T> | StreamCallResult<T | CallWithToolsResult<T>>> {
    if (params.signal?.aborted) {
      throw new LLMError('LLM request aborted', 'aborted');
    }

    const requestId = params.requestId ?? globalThis.crypto.randomUUID();

    // Read from the original `params` object, before any clone drops the marker.
    const cachedCallState = this.cachedCallInnerParams.get(params);
    const isCachedCallInner = cachedCallState !== undefined;

    const {
      params: effectiveParams,
      signal: effectiveSignal,
      breakController,
      dispose,
    } = setupCallSignal(params, !isCachedCallInner);

    // One bag per logical call, shared by `wrap` and `transform` on every target.
    const middlewareState = cachedCallState ?? createMiddlewareStateBag();

    try {
      // `wrap` also spans the sole target breaker check, so a circuit open
      // rejection is visible to it.
      const wrapped = await runOperation(
        this.runOperationDependencies,
        effectiveParams,
        requestId,
        middlewareState,
        () =>
          runReservedLogicalCall(this.logicalCallDependencies, effectiveParams, {
            requestId,
            middlewareState,
            breakController,
            onRefundError: (logMessage, error) => logError(this.logger, logMessage, error),
          }),
        isCachedCallInner,
      );

      return wrapped.value as
        | T
        | CallWithToolsResult<T>
        | StreamCallResult<T | CallWithToolsResult<T>>;
    } catch (error) {
      throw stampDeadlineCode(error, effectiveSignal);
    } finally {
      dispose();
    }
  }

  /** Kept on `VernLLM` since tests drive the caching core directly through it. */
  private runCached<T>(params: InternalCacheParams<T>) {
    return this.cacheOrchestrator.runCached(params);
  }

  /**
   * Removes a cached response when the adapter supports deletion. Invalidation is up to the app.
   *
   * @param key The raw cache key, resolved through the adapter's `resolveKey` first.
   */
  async deleteCache(key: string): Promise<void> {
    await this.cacheOrchestrator.deleteCache(key);
  }

  /**
   * `call()` with caching. Concurrent misses for one `cacheKey` share a single in-flight call.
   * Works with `stream` and `tools`; with tools the whole result is cached, tool call decisions
   * included. A caller's own abort or deadline only ends its wait; the shared request is aborted
   * once every caller has left.
   *
   * @param params Cache settings plus `call`, the `CallParams` for the underlying call.
   * @returns The cached value on a hit, or the fresh result on a miss.
   */
  async cachedCall<T, const Tools extends readonly ToolDefinition[] = ToolDefinition[]>(
    params: CachedStreamToolCallParams<T, Tools>,
  ): Promise<StreamCallResult<CallWithToolsResult<T, Tools>>>;

  async cachedCall<const Tools extends readonly ToolDefinition[] = ToolDefinition[]>(
    params: CachedStreamConditionalStringToolCallParams<Tools>,
  ): Promise<StreamCallResult<string | CallWithToolsResult<string, Tools>>>;

  async cachedCall<T, const Tools extends readonly ToolDefinition[] = ToolDefinition[]>(
    params: CachedStreamConditionalToolCallParams<T, Tools>,
  ): Promise<StreamCallResult<T | CallWithToolsResult<T, Tools>>>;

  async cachedCall(
    params: CachedStreamJsonModeDisabledCallParams,
  ): Promise<StreamCallResult<string>>;

  async cachedCall(
    params: CachedStreamJsonModeEnabledCallParams,
  ): Promise<StreamCallResult<JsonValue>>;

  async cachedCall<T>(params: CachedStreamCallParams<T>): Promise<StreamCallResult<T>>;

  async cachedCall<T, const Tools extends readonly ToolDefinition[] = ToolDefinition[]>(
    params: CachedToolCallParams<T, Tools>,
  ): Promise<CallWithToolsResult<T, Tools>>;

  async cachedCall<const Tools extends readonly ToolDefinition[] = ToolDefinition[]>(
    params: CachedConditionalStringToolCallParams<Tools>,
  ): Promise<string | CallWithToolsResult<string, Tools>>;

  async cachedCall<T, const Tools extends readonly ToolDefinition[] = ToolDefinition[]>(
    params: CachedConditionalToolCallParams<T, Tools>,
  ): Promise<T | CallWithToolsResult<T, Tools>>;

  async cachedCall(params: CachedJsonModeDisabledCallParams): Promise<string>;

  async cachedCall(params: CachedJsonModeEnabledCallParams): Promise<JsonValue>;

  async cachedCall<T>(params: CachedCallParams<T>): Promise<T>;

  async cachedCall<T>(
    params:
      | CachedCallParams<T>
      | CachedToolCallParams<T>
      | CachedConditionalToolCallParams<T>
      | CachedStreamCallParams<T>
      | CachedStreamToolCallParams<T>
      | CachedStreamConditionalToolCallParams<T>
      | CachedJsonModeDisabledCallParams
      | CachedJsonModeEnabledCallParams
      | CachedStreamJsonModeDisabledCallParams
      | CachedStreamJsonModeEnabledCallParams,
  ): Promise<T | CallWithToolsResult<T> | StreamCallResult<T | CallWithToolsResult<T>>> {
    const { call: callParams, ...cacheParams } = params;
    const restCallParams = callParams as CallParams<T>;

    // The per call hooks would be silently dropped, since the cached value
    // may be shared by several callers.
    if (restCallParams.reserveUsage || restCallParams.refundUsage) {
      throw new LLMError(
        '`reserveUsage`/`refundUsage` were set inside `call`, where cachedCall ignores them. Move them ' +
          'to the top level of the cachedCall() params, alongside cacheKey/ttl, instead.',
        'invalid_params',
      );
    }

    const requestId = restCallParams.requestId ?? globalThis.crypto.randomUUID();
    const middlewareState = createMiddlewareStateBag();

    const resolvedCacheKey = await this.cacheOrchestrator.resolveCacheKey(cacheParams.cacheKey);
    const { holder: metaHolder, release: releaseMetaHolder } = claimMetaHolder(
      this.cachedCallMeta,
      resolvedCacheKey,
      (key) => this.cacheOrchestrator.inFlightFor(key),
    );

    const callerMeta = restCallParams.meta;
    const syncCallerMeta = () => {
      if (callerMeta) callerMeta.current = metaHolder.current;
    };

    // These end only this caller's wait. The shared request has its own signal
    // from the orchestrator, aborted once every participant has left.
    const { signal: participantSignal, timer: deadlineTimer } = setupDeadline(
      restCallParams.deadlineMs,
      combineSignals([cacheParams.signal, restCallParams.signal]),
    );
    const participantCacheParams = { ...cacheParams, signal: participantSignal };

    const participantParams = {
      ...restCallParams,
      requestId,
      signal: participantSignal,
    } as CallParams<T>;

    // The inner call runs once for all participants, so it takes the shared
    // signal and no per caller deadline. Marked so its own `runOperation`
    // skips `wrap` and reuses this state bag.
    const callShared = (sharedSignal: AbortSignal) => {
      const { deadlineMs: _deadlineMs, ...sharedParams } = participantParams;
      const innerParams = { ...sharedParams, signal: sharedSignal, meta: metaHolder };
      this.cachedCallInnerParams.set(innerParams, middlewareState);
      return this.call(innerParams).finally(() => {
        syncCallerMeta();
        this.cachedCallInnerParams.delete(innerParams);
      });
    };

    // A stream hands the holder's release to `finalResult`, since a joiner may
    // still attach after this returns.
    let releaseOnSettle = false;

    try {
      const wrapped = await runOperation(
        this.runOperationDependencies,
        participantParams,
        requestId,
        middlewareState,
        async () => {
          const value = restCallParams.stream
            ? await this.cacheOrchestrator.runCachedStream(
                {
                  ...participantCacheParams,
                  openStream: (sharedSignal) =>
                    callShared(sharedSignal) as Promise<StreamCallResult<unknown>>,
                },
                Boolean(restCallParams.tools),
              )
            : await this.runCached({ ...participantCacheParams, fn: callShared });

          return { value, meta: metaHolder.current };
        },
      );

      if (restCallParams.stream) {
        const streamResult = wrapped.value as StreamCallResult<T | CallWithToolsResult<T>>;
        const onStreamSettled = () => {
          syncCallerMeta();
          releaseMetaHolder();
        };

        releaseOnSettle = true;
        void streamResult.finalResult.then(onStreamSettled, onStreamSettled);

        return streamResult;
      }

      syncCallerMeta();

      return wrapped.value as T | CallWithToolsResult<T>;
    } catch (error) {
      throw stampDeadlineCode(error, participantSignal);
    } finally {
      if (!releaseOnSettle) releaseMetaHolder();
      clearTimeout(deadlineTimer);
    }
  }

  /**
   * @param target.index Which target to read. Defaults to the primary.
   * @param target.model Which model bucket to read, if the target isolates by model.
   * @returns The breaker state, or `undefined` if that target has no breaker.
   * @throws {RangeError} If `target.index` names no target.
   */
  getCircuitState(target?: CircuitTarget): CircuitState | undefined {
    const executor = resolveExecutor(this.executors, target?.index ?? 0, 'getCircuitState');
    warnIfModelUnsupported(executor.isolateByModel, target?.model, 'getCircuitState', this.logger);

    return executor.getCircuitState(target?.model ?? executor.model);
  }

  /**
   * @param target.index Which target to read. Defaults to the primary.
   * @param target.model Which model bucket to read, if the target isolates by model.
   * @returns Failure counts by `LLMErrorCode`, `'unknown'` for a missing
   * code, or `undefined` if that target has no breaker.
   * @throws {RangeError} If `target.index` names no target.
   */
  getFailureBreakdown(
    target?: CircuitTarget,
  ): Partial<Record<LLMErrorCode | 'unknown', number>> | undefined {
    const executor = resolveExecutor(this.executors, target?.index ?? 0, 'getFailureBreakdown');
    warnIfModelUnsupported(
      executor.isolateByModel,
      target?.model,
      'getFailureBreakdown',
      this.logger,
    );

    return executor.getFailureBreakdown(target?.model ?? executor.model);
  }

  /**
   * @param target.index Which target to read. Defaults to the primary.
   * @returns The retry traffic and ratio in the trailing window, or `undefined` without a budget.
   * Budgets are per target, not per model.
   * @throws {RangeError} If `target.index` names no target.
   */
  getRetryBudgetState(
    target?: Pick<CircuitTarget, 'index'>,
  ): { attempts: number; retryRatio: number } | undefined {
    const executor = resolveExecutor(this.executors, target?.index ?? 0, 'getRetryBudgetState');
    return executor.getRetryBudgetState();
  }

  /**
   * @param target.index Which target to read. Defaults to the primary.
   * @returns Current rate limit levels, or `undefined` without a limiter. Limiters are per target,
   * not per model.
   * @throws {RangeError} If `target.index` names no target.
   */
  getRateLimitState(target?: Pick<CircuitTarget, 'index'>): RateLimitState | undefined {
    const executor = resolveExecutor(this.executors, target?.index ?? 0, 'getRateLimitState');
    return executor.getRateLimitState();
  }

  /**
   * @param model Which model bucket to read, for targets that isolate by model.
   * @returns Every target's state, in chain order.
   */
  getCircuitStates(model?: string): TargetCircuitState[] {
    return this.executors.map((executor, index) => ({
      provider: executor.providerName,
      index,
      isFallback: index > 0,
      isolateByModel: executor.isolateByModel,
      state: executor.getCircuitState(model ?? executor.model),
    }));
  }

  /**
   * The live counterpart of `getRateLimitState`, asking the limiter for its current levels.
   *
   * @param target.index Which target to read. Defaults to the primary.
   * @returns This target's live rate limit levels, or `undefined` if that target has no limiter
   * configured.
   * @throws {RangeError} If `target.index` names no target.
   */
  async readRateLimitState(
    target?: Pick<CircuitTarget, 'index'>,
  ): Promise<RateLimitState | undefined> {
    const executor = resolveExecutor(this.executors, target?.index ?? 0, 'readRateLimitState');
    return executor.readRateLimitState();
  }

  /**
   * The live counterpart of `getCircuitStates`, asking each breaker for its current state.
   *
   * @param model Which model bucket to read, for targets that isolate by model.
   * @returns Every target's state, in chain order.
   */
  async readCircuitStates(model?: string): Promise<TargetCircuitState[]> {
    return Promise.all(
      this.executors.map(async (executor, index) => ({
        provider: executor.providerName,
        index,
        isFallback: index > 0,
        isolateByModel: executor.isolateByModel,
        state: await executor.readCircuitState(model ?? executor.model),
      })),
    );
  }

  /**
   * Manually opens a target's breaker, e.g. to pull a provider out of
   * rotation ahead of known maintenance instead of waiting for it to fail.
   *
   * @param target.index Which target to open. Defaults to the primary.
   * @param target.model Which model bucket to open, if the target isolates by model.
   * @throws {RangeError} If `target.index` names no target.
   */
  openCircuit(target?: CircuitTarget): void {
    const executor = resolveExecutor(this.executors, target?.index ?? 0, 'openCircuit');
    warnIfModelUnsupported(executor.isolateByModel, target?.model, 'openCircuit', this.logger);
    // No logical call behind a manual invocation, so mint a fresh one.
    executor.openCircuit(target?.model ?? executor.model, {
      requestId: globalThis.crypto.randomUUID(),
      state: createMiddlewareStateBag(),
    });
  }

  /**
   * Manually closes a target's breaker, e.g. once a provider is confirmed
   * healthy again without waiting out the cooldown.
   *
   * @param target.index Which target to close. Defaults to the primary.
   * @param target.model Which model bucket to close, if the target isolates by model.
   * @throws {RangeError} If `target.index` names no target.
   */
  closeCircuit(target?: CircuitTarget): void {
    const executor = resolveExecutor(this.executors, target?.index ?? 0, 'closeCircuit');
    warnIfModelUnsupported(executor.isolateByModel, target?.model, 'closeCircuit', this.logger);
    // See `openCircuit`.
    executor.closeCircuit(target?.model ?? executor.model, {
      requestId: globalThis.crypto.randomUUID(),
      state: createMiddlewareStateBag(),
    });
  }
}
