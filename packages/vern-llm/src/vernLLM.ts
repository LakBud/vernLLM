import { randomUUID } from 'crypto';

import { CacheOrchestrator } from './internal/cache/cacheOrchestrator.js';
import {
  makeEventReporter,
  resolveExecutor,
  warnIfModelUnsupported,
} from './internal/circuitBreaker.utils.js';
import { CallExecutor } from './internal/execution/callExecutor.js';
import {
  executeLogicalCall,
  executeLogicalStreamCall,
  type LogicalCallDependencies,
} from './internal/execution/logicalCall.js';
import { runOperation, type RunOperationDependencies } from './internal/execution/runOperation.js';
import { setupDeadline, stampDeadlineCode } from './internal/execution/utils/deadline.utils.js';
import { DEFAULT_MIDDLEWARE_TIMEOUT_MS } from './internal/execution/utils/middleware.utils.js';
import {
  withReservedUsage,
  withReservedUsageForStream,
} from './internal/execution/utils/usage.utils.js';
import { buildExecutors } from './internal/executorFactory.js';
import { createSafeLogger } from './internal/logger.utils.js';
import { ConsoleLogger, type Logger } from './logger.js';
import {
  InMemoryCacheAdapter,
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
  type FallbackOn,
  type FallbackTarget,
  type JsonModeDisabledCallParams,
  type JsonModeEnabledCallParams,
  type JsonValue,
  type StreamCallResult,
  type StreamConditionalStringToolCallParams,
  type StreamJsonModeDisabledCallParams,
  type StreamJsonModeEnabledCallParams,
  type CachedStreamJsonModeDisabledCallParams,
  type CachedStreamJsonModeEnabledCallParams,
  type CallMeta,
  type CallResult,
  type VernLLMMiddleware,
  type StreamChunk,
  type TargetCircuitState,
  type CircuitTarget,
  type StreamEnabledCallParams,
  type ToolDefinition,
  type ToolEnabledCallParams,
  type ToolsDisabledCallParams,
  type VernLLMEvent,
  type VernLLMOptions,
} from './types/index.js';
import { createMiddlewareStateBag, type MiddlewareStateBag } from './types/middleware.js';

import type { CircuitState } from './circuitBreaker.js';
import type { InternalCacheParams } from './internal/cache/utils/cache.utils.js';

/**
 * A LLM call framework for resilience, observability and control. This is VernLLM!
 *
 * Adds retry with backoff and jitter, per-attempt timeouts, an optional
 * circuit breaker, JSON parsing with optional schema validation, usage
 * tracking, and an optional response cache. All configurable, all opt-in
 * beyond sensible defaults.
 */
export class VernLLM {
  private readonly logger: Logger;

  /**
   * One `CallExecutor` per provider target: index 0 is the primary,
   * everything after it is a `fallback` target, in the order declared.
   * Walked by `runFallbackChain`, moving to the next entry only when
   * `fallbackOn` says to.
   */
  private readonly executors: CallExecutor[];

  /** Decides whether a failed target is followed by the next one or the chain stops. See `VernLLMOptions['fallbackOn']`. */
  private readonly fallbackOn: FallbackOn;

  /** Reports a `'fallback'` event when the chain moves to the next target. Shared `onEvent` plumbing, same as every executor's. */
  private readonly reportEvent: (event: VernLLMEvent) => void;

  /** Owns cache reads/writes and in-flight coalescing for `cachedCall()`. Only calls back into `this.call()` as an opaque function. */
  private readonly cacheOrchestrator: CacheOrchestrator;

  /** See `VernLLMOptions.middleware`. Sorted once here by `priority`, ascending, ties broken by original array order. */
  private readonly middleware: VernLLMMiddleware[];

  /** See `VernLLMOptions.middlewareTimeoutMs`. Bounds `transform` and a function `enabled`; `wrap` itself is never bounded by this. */
  private readonly middlewareTimeoutMs: number;

  /**
   * Maps `cachedCall()`'s inner `this.call(...)` params to its own
   * `middlewareState`, so that call's own `runOperation` skips wrapping
   * again and reuses the same state bag `wrap` just ran with (so a
   * value `wrap` sets is visible to `transform`, same as a direct
   * call). Keyed by object identity, not `requestId`, since two
   * concurrent `cachedCall()`s can share an explicit `requestId`.
   */
  private readonly cachedCallInnerParams = new WeakMap<CallParams<unknown>, MiddlewareStateBag>();

  /**
   * Shares one `CallMeta` holder across every `cachedCall()` in flight
   * for the same resolved cache key, so a joining invocation (never
   * calls `call()` itself) reports the trigger's real metadata instead
   * of `undefined`. A true cache hit never creates an entry, so it
   * still reports no metadata correctly.
   */
  private readonly cachedCallMeta = new Map<string, { current?: CallMeta }>();

  /**
   * @param options Client, model, and tunables. Defaults: `maxRetries` 1,
   * `timeoutMs` 25000, `baseDelayMs` 500, `defaultMaxTokens` 1000,
   * `defaultTemperature` 0.2, `cache` an in-memory adapter,
   * `nonRetryableStatus` `[400, 401, 403, 404, 422]`, `debug` false.
   */
  constructor(options: VernLLMOptions) {
    this.logger = createSafeLogger(options.logger ?? new ConsoleLogger(options.debug ?? false));

    const providerName = options.name ?? 'primary';

    this.cacheOrchestrator = new CacheOrchestrator(
      options.cache ?? new InMemoryCacheAdapter(),
      this.logger,
    );

    this.fallbackOn = options.fallbackOn ?? defaultFallbackOn;
    this.reportEvent = makeEventReporter(options.onEvent, this.logger);
    this.middleware = [...(options.middleware ?? [])].sort(
      (a, b) => (a.priority ?? 0) - (b.priority ?? 0),
    );
    this.middlewareTimeoutMs = options.middlewareTimeoutMs ?? DEFAULT_MIDDLEWARE_TIMEOUT_MS;

    // The primary target's shared knobs, resolved once here rather than
    // inline in the retry-tunable default below, since fallback targets
    // that omit a field inherit this resolved value, not the raw
    // (possibly-undefined) option.
    const primaryDefaultTemperature =
      options.defaultTemperature === undefined ? 0.2 : options.defaultTemperature;
    const primaryDefaultReasoningEffort = options.defaultReasoningEffort;
    const primaryDefaultBudgetTokens = options.defaultBudgetTokens;

    // The primary, shaped like a `FallbackTarget` so it walks the same
    // build loop as every declared fallback target below. Its own
    // `circuitBreaker`/`rateLimit` are read directly off `options`
    // instead of this list, since only the primary carries them at the
    // top level (a `FallbackTarget`'s copies are genuinely independent,
    // never inherited, see `FallbackTarget`'s docs).
    const primaryTarget: FallbackTarget = {
      client: options.client,
      model: options.model,
      name: providerName,
      maxRetries: options.maxRetries,
      timeoutMs: options.timeoutMs,
      chunkIdleTimeoutMs: options.chunkIdleTimeoutMs,
      baseDelayMs: options.baseDelayMs,
      defaultMaxTokens: options.defaultMaxTokens,
      defaultTemperature: primaryDefaultTemperature,
      defaultReasoningEffort: primaryDefaultReasoningEffort,
      defaultBudgetTokens: primaryDefaultBudgetTokens,
      nonRetryableStatus: options.nonRetryableStatus,
      circuitBreaker: options.circuitBreaker,
      rateLimit: options.rateLimit,
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
      baseDelayMs: options.baseDelayMs,
      defaultMaxTokens: options.defaultMaxTokens,
      nonRetryableStatus: options.nonRetryableStatus,
      parseJson: options.parseJson,
      redact: options.redact,
      onUsage: options.onUsage,
      onUsageFailure: options.onUsageFailure,
      onEvent: options.onEvent,
      logger: this.logger,
      middleware: this.middleware,
      middlewareTimeoutMs: this.middlewareTimeoutMs,
    });
  }

  /** Logs a failed refundUsage attempt via the configured logger. */
  private logRefundError(logMessage: string, error: unknown): void {
    this.logger.error(logMessage, {
      message: error instanceof Error ? error.message : 'unknown',
    });
  }

  /** Everything `executeLogicalCall`/`executeLogicalStreamCall` (in `logicalCall.ts`) need from this instance, gathered once so `call()` doesn't rebuild it per invocation. */
  private get logicalCallDependencies(): LogicalCallDependencies {
    return {
      executors: this.executors,
      fallbackOn: this.fallbackOn,
      reportEvent: this.reportEvent,
      middleware: this.middleware,
      middlewareTimeoutMs: this.middlewareTimeoutMs,
      logger: this.logger,
    };
  }

  /** Everything `runOperation` (in `runOperation.ts`) needs from this instance, gathered once so `call()`/`cachedCall()` don't rebuild it per invocation. */
  private get runOperationDependencies(): RunOperationDependencies {
    return {
      middleware: this.middleware,
      primaryExecutor: this.executors[0]!,
      middlewareTimeoutMs: this.middlewareTimeoutMs,
      logger: this.logger,
      reportEvent: this.reportEvent,
    };
  }

  /**
   * Makes a single logical LLM call, retrying on failure per the configured
   * policy. Fails fast if the breaker is open or the signal is already
   * aborted. Rejects with a normalized `LLMError` on exhausted retries.
   *
   * Supports `tools`, `stream`, and JSON mode/schema, in any combination.
   * See the Tool Calling and Streaming docs for return-shape details and
   * the TypeScript overloads that select between them.
   *
   * @param params System/user content plus per-call overrides. See `CallParams`.
   * @returns The parsed response (or raw string if `jsonMode` is false), a
   * `CallWithToolsResult<T>` when `tools` is set, or a `{ chunks,
   * finalResult }` `StreamCallResult` when `stream: true`. See `StreamCallResult`.
   */
  async call<T = unknown>(
    params: StreamEnabledCallParams<T> & ToolsDisabledCallParams<T>,
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

  async call<T = unknown>(params: ToolsDisabledCallParams<T>): Promise<ContentResult<T>>;

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

    const requestId = params.requestId ?? randomUUID();

    // Captured from the original `params` reference before any clone
    // below, so a later clone doesn't lose the marker. See
    // `cachedCallInnerParams`'s docs.
    const sharedMiddlewareState = this.cachedCallInnerParams.get(params);
    const skipCachedCallWrap = sharedMiddlewareState !== undefined;

    // deadlineMs composes one more AbortSignal on top of whatever the
    // caller already passed, using the same AbortSignal.any pattern
    // withTimeout already established, so every existing signal check
    // downstream (shouldRetry, waitForRetry, withTimeout, the top of
    // withReservedUsage) automatically also stops a deadline-exceeded
    // call, no per-site change needed.
    const { signal: effectiveSignal, timer: deadlineTimer } = setupDeadline(
      params.deadlineMs,
      params.signal,
    );

    const effectiveParams =
      effectiveSignal === params.signal ? params : { ...params, signal: effectiveSignal };

    // Created once per logical call, before any target is chosen, so a
    // value a `wrap` middleware sets is visible to that same middleware's
    // `transform` (and vice versa) on every attempt/fallback target
    // underneath it. Reused from `cachedCall()`'s own bag on its inner
    // call, rather than always creating a fresh one.
    const middlewareState = sharedMiddlewareState ?? createMiddlewareStateBag();

    try {
      // A lone target (no `fallback` configured) keeps the exact pre-fallback
      // contract: the breaker is checked once, up front, before usage is
      // reserved, so a call that's definitely blocked never pays a
      // reserve-then-refund round trip. This can only be hoisted out of the
      // chain for the sole-target case: `assertBreakerClosed` claims a
      // half-open trial slot as a side effect, which must happen exactly
      // once per logical call, so with more than one target the check has
      // to stay inside `runFallbackChain`, where an open primary is just
      // another target failure that `fallbackOn` can fall over from.
      const soleTarget = this.executors.length === 1;

      // `wrap` spans the sole-target breaker precheck too, not only
      // `runFallbackChain`: on a single-target setup a circuit-open
      // rejection happens here, before `runFallbackChain` is ever
      // reached, so wrapping only the fallback chain would make that
      // rejection, a completely normal outcome of a call, invisible to
      // every `wrap` middleware.
      const wrapped = await runOperation(
        this.runOperationDependencies,
        effectiveParams,
        requestId,
        middlewareState,
        async () => {
          if (soleTarget) {
            // Checked before claiming a half-open trial slot: without it,
            // a signal that aborted during the `wrap` chain above could
            // still claim the trial, then fail `withReservedUsage`'s own
            // abort check before `run()` ever fires `recordSuccess`/
            // `recordFailure`, leaving the breaker stuck mid-trial.
            if (effectiveParams.signal?.aborted) {
              throw new LLMError('LLM request aborted', 'aborted');
            }

            this.executors[0]!.assertBreakerClosed(effectiveParams.model, {
              requestId,
              state: middlewareState,
              signal: effectiveParams.signal,
            });
          }

          let meta: CallMeta | undefined;

          // Captures `meta` from the `{ value, meta }` shape both
          // `executeLogicalCall`/`executeLogicalStreamCall` return, so the
          // stream/non-stream branches below only differ in which
          // `withReservedUsage*`/`executeLogical*Call` pair they use, not
          // in how the result is unpacked.
          const captureMeta = async <V>(
            resultPromise: Promise<{ value: V; meta?: CallMeta }>,
          ): Promise<V> => {
            const result = await resultPromise;
            meta = result.meta;
            return result.value;
          };

          if (effectiveParams.stream) {
            // Same breaker/logging treatment as non-streaming, applied around
            // opening the stream; mid-stream failures are handled separately
            // inside the executor and never fall over (see `runFallbackChain`).
            // Usage refund/report is deferred onto finalResult, since call()
            // must return { chunks, finalResult } before the real outcome is
            // known. `effectiveParams.meta.current` is still populated by the
            // time we return below, though: `executeLogicalStreamCall` writes
            // it as a side effect on this same `effectiveParams` object once
            // the stream opens, which is also all `call()` itself waits for.
            const value = await withReservedUsageForStream(
              effectiveParams,
              () =>
                captureMeta(
                  executeLogicalStreamCall(
                    this.logicalCallDependencies,
                    effectiveParams,
                    requestId,
                    soleTarget,
                    middlewareState,
                  ),
                ),
              effectiveParams.signal,
              (logMessage, error) => this.logRefundError(logMessage, error),
            );

            return { value, meta };
          }

          const value = await withReservedUsage(
            effectiveParams,
            false,
            () =>
              captureMeta(
                executeLogicalCall(
                  this.logicalCallDependencies,
                  effectiveParams,
                  requestId,
                  soleTarget,
                  middlewareState,
                ),
              ),
            effectiveParams.signal,
            (logMessage, error) => this.logRefundError(logMessage, error),
          );

          return { value, meta };
        },
        skipCachedCallWrap,
      );

      if (effectiveParams.stream) {
        return wrapped.value as {
          chunks: AsyncIterable<StreamChunk>;
          finalResult: Promise<T | CallWithToolsResult<T>>;
        };
      }

      return wrapped.value as T | CallWithToolsResult<T>;
    } catch (error) {
      throw stampDeadlineCode(error, effectiveSignal);
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  /**
   * Thin delegator kept private on `VernLLM` (rather than only existing on
   * `CacheOrchestrator`) since it's the one caching primitive exercised
   * directly by white-box tests, independent of the public `cachedCall()`
   * surface.
   */
  private runCached<T>(params: InternalCacheParams<T>) {
    return this.cacheOrchestrator.runCached(params);
  }

  /**
   * Removes a cached response by key when the configured cache adapter
   * supports deletion. Cache invalidation is the caller's responsibility;
   * only the application knows when cached data is stale.
   *
   * @param key The raw cache key (resolved through the adapter's
   * `resolveKey`, if any, before deletion).
   */
  async deleteCache(key: string): Promise<void> {
    await this.cacheOrchestrator.deleteCache(key);
  }

  /**
   * Cache wrapper composing `call` + caching, so cached LLM calls
   * automatically get retry/timeout/circuit-breaker behavior. Concurrent
   * misses for the same `cacheKey` share a single in-flight call, avoiding
   * cache stampedes. Supports `stream: true` and `tools` in any combination.
   *
   * When `call.tools` is set, this caches the whole result including any
   * `tool_calls` decision, not just final answers; use a short `ttl` or a
   * separate `cacheKey` if a tool's result shouldn't be reused across calls.
   *
   * @param params `cacheKey`, `ttl`, optional
   * `reserveUsage`/`refundUsage`/`signal`, plus `call`, the `CallParams`
   * to pass through to `this.call(...)`. The top-level `signal` governs
   * the cached operation and its usage hooks only; to also abort the
   * underlying provider request, set `signal` inside `call`.
   * @returns The cached value on a hit, or the freshly-called result on a miss.
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

    // `callParams`'s type no longer includes reserveUsage/refundUsage (see
    // CachedCallParams et al.): a well-typed caller can't reach this branch
    // at all, TypeScript rejects it at the call site instead. This check is
    // a defense-in-depth backstop for callers that bypass the type system
    // (plain JS, or an `as any` cast), and now throws instead of silently
    // ignoring the hooks and continuing: reserveUsage/refundUsage exist as
    // a cost-control safety mechanism, so silently dropping them fails
    // open, not safe, which a warning callers may never see doesn't fix.
    const restCallParams = callParams as CallParams<T>;

    if (restCallParams.reserveUsage || restCallParams.refundUsage) {
      throw new LLMError(
        '`reserveUsage`/`refundUsage` were set inside `call`, where cachedCall ignores them. Move them ' +
          'to the top level of the cachedCall() params, alongside cacheKey/ttl, instead.',
        'invalid_params',
      );
    }

    const requestId = restCallParams.requestId ?? randomUUID();
    const middlewareState = createMiddlewareStateBag();

    // Maps each inner `this.call()`'s own `params` object to this
    // `middlewareState`, so its `runOperation` skips wrapping again
    // (the *outer* call below still wraps, since its own `params` is
    // never marked) and its `transform` reuses the same bag `wrap` just
    // ran with. See `cachedCallInnerParams`'s docs.
    //
    // `metaHolder` is shared across trigger and joiners for this
    // resolved cache key; see `cachedCallMeta`'s docs.
    const resolvedCacheKey = await this.cacheOrchestrator.resolveCacheKey(cacheParams.cacheKey);
    let metaHolder = this.cachedCallMeta.get(resolvedCacheKey);
    let ownsMetaHolder = false;

    if (!metaHolder) {
      metaHolder = {};
      ownsMetaHolder = true;
      this.cachedCallMeta.set(resolvedCacheKey, metaHolder);
    }

    const releaseMetaHolder = () => {
      if (ownsMetaHolder) this.cachedCallMeta.delete(resolvedCacheKey);
    };

    const callerMeta = restCallParams.meta;

    const callWrapped = (params: CallParams<T>) => {
      const innerParams = { ...params, meta: metaHolder };
      this.cachedCallInnerParams.set(innerParams, middlewareState);
      return this.call(innerParams).finally(() => {
        // `this.call()` writes into `metaHolder`, the internal holder
        // shared across trigger/joiners for this cache key. A
        // caller-supplied `meta` on the inner `call` params (this
        // function's own `params`, not the one passed to `this.call()`)
        // is a separate out-parameter contract callers may still be
        // relying on, so forward the written value there too instead
        // of silently dropping it.
        if (callerMeta) callerMeta.current = metaHolder.current;
        this.cachedCallInnerParams.delete(innerParams);
      });
    };

    if (restCallParams.stream) {
      const streamParams = { ...restCallParams, requestId } as StreamEnabledCallParams<T>;

      let wrapped: CallResult;

      try {
        wrapped = await runOperation(
          this.runOperationDependencies,
          streamParams,
          requestId,
          middlewareState,
          async () => {
            const value = await this.cacheOrchestrator.runCachedStream(
              {
                ...cacheParams,
                openStream: () => callWrapped(streamParams) as Promise<StreamCallResult<unknown>>,
              },
              Boolean(restCallParams.tools),
            );

            // A cache hit never goes through `call()` (and so never through
            // `executeLogicalStreamCall`), so `metaHolder.current` stays
            // `undefined` in that case, correctly: nothing was actually
            // spent and no target answered this call.
            return { value, meta: metaHolder.current };
          },
        );
      } catch (error) {
        // No stream result exists yet, so nothing is left joinable.
        releaseMetaHolder();
        throw error;
      }

      const streamResult = wrapped.value as StreamCallResult<T | CallWithToolsResult<T>>;

      // Released once the real outcome is known, not just once the
      // stream opens, since a joiner can still arrive in between. Uses
      // `.then(fn, fn)`, not `.finally(fn)`, so a mid-stream rejection
      // doesn't leave an unhandled promise behind.
      void streamResult.finalResult.then(releaseMetaHolder, releaseMetaHolder);

      return streamResult;
    }

    const paramsWithId = { ...restCallParams, requestId } as CallParams<T>;

    try {
      const wrapped = await runOperation(
        this.runOperationDependencies,
        paramsWithId,
        requestId,
        middlewareState,
        async () => {
          const value = await this.runCached({
            ...cacheParams,
            fn: () => callWrapped(paramsWithId),
          });

          return { value, meta: metaHolder.current };
        },
      );

      return wrapped.value as T | CallWithToolsResult<T>;
    } finally {
      // See the matching comment in the streaming branch above.
      releaseMetaHolder();
    }
  }

  /**
   * @param target.index Which target to read. Defaults to the primary.
   * @param target.model Which model bucket to read, if the target isolates by model.
   * @returns The breaker state, or `undefined` if that target has no breaker.
   * @throws {RangeError} If `target.index` names no target. Lets a real
   * target with no breaker (`undefined`) stay distinguishable from a
   * target that doesn't exist.
   */
  getCircuitState(target?: CircuitTarget): CircuitState | undefined {
    const executor = resolveExecutor(this.executors, target?.index ?? 0, 'getCircuitState');
    warnIfModelUnsupported(executor.isolateByModel, target?.model, 'getCircuitState', this.logger);

    return executor.getCircuitState(target?.model ?? executor.model);
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
      requestId: randomUUID(),
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
      requestId: randomUUID(),
      state: createMiddlewareStateBag(),
    });
  }
}
