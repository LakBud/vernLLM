import { randomUUID } from 'crypto';

import { CacheOrchestrator } from './internal/cache/cacheOrchestrator.js';
import { buildCircuitBreaker } from './internal/circuitBreaker.utils.js';
import { CallExecutor } from './internal/execution/callExecutor.js';
import { withReservedUsage, withReservedUsageForStream } from './internal/execution/usage.utils.js';
import { ConsoleLogger, type Logger } from './logger.js';
import { RateLimiter } from './rateLimit.js';
import {
  InMemoryCacheAdapter,
  LLMError,
  type CachedCallParams,
  type CachedStreamCallParams,
  type CachedStreamToolCallParams,
  type CachedToolCallParams,
  type CallParams,
  type CallWithToolsResult,
  type StreamCallResult,
  type StreamEnabledCallParams,
  type ToolEnabledCallParams,
  type VernLLMOptions,
} from './types/index.js';

import type { InternalCacheParams } from './internal/cache/cache.utils.js';

/**
 * A resilient layer around an LLM chat completions client. This is VernLLM!
 *
 * Adds retry with backoff and jitter, per-attempt timeouts, an optional
 * circuit breaker, JSON parsing with optional schema validation, usage
 * tracking, and an optional response cache. All configurable, all opt-in
 * beyond sensible defaults.
 */
export class VernLLM {
  private readonly logger: Logger;

  /**
   * Owns request building, retry/timeout, the circuit breaker, and the
   * rate limiter for the (currently single) provider target. `call()`
   * delegates every per-target concern here.
   */
  private readonly executor: CallExecutor;

  /**
   * Owns cache key resolution, cache reads/writes, and in-flight
   * coalescing for `cachedCall()`. Independent of `executor`: it only
   * ever calls back into `this.call()` as an opaque function.
   */
  private readonly cacheOrchestrator: CacheOrchestrator;

  /**
   * @param options Client, model, and tunables. Defaults: `maxRetries` 1,
   * `timeoutMs` 25000, `baseDelayMs` 500, `defaultMaxTokens` 1000,
   * `defaultTemperature` 0.2, `cache` an in-memory adapter,
   * `nonRetryableStatus` `[400, 401, 403, 404, 422]`, `debug` false.
   */
  constructor(options: VernLLMOptions) {
    this.logger = options.logger ?? new ConsoleLogger(options.debug ?? false);

    const providerName = options.name ?? 'primary';

    this.cacheOrchestrator = new CacheOrchestrator(
      options.cache ?? new InMemoryCacheAdapter(),
      this.logger,
    );

    // Built before the executor: onStateChange fires from inside the
    // breaker itself, which the executor is merely handed a reference to.
    const breaker = buildCircuitBreaker(options, providerName, this.logger);

    this.executor = new CallExecutor(providerName, options.client, options.model, {
      maxRetries: options.maxRetries ?? 1,
      timeoutMs: options.timeoutMs ?? 25_000,
      chunkIdleTimeoutMs: options.chunkIdleTimeoutMs ?? 30_000,
      baseDelayMs: options.baseDelayMs ?? 500,
      defaultMaxTokens: options.defaultMaxTokens ?? 1000,
      defaultTemperature:
        options.defaultTemperature === undefined ? 0.2 : options.defaultTemperature,
      nonRetryableStatus: options.nonRetryableStatus ?? [400, 401, 403, 404, 422],
      parseJson: options.parseJson,
      logger: this.logger,
      onUsage: options.onUsage,
      onUsageFailure: options.onUsageFailure,
      onEvent: options.onEvent,
      breaker,
      limiter: options.rateLimit ? new RateLimiter(options.rateLimit) : undefined,
    });
  }

  /** Logs a failed refundUsage attempt via the configured logger. */
  private logRefundError(logMessage: string, error: unknown): void {
    this.logger.error(logMessage, {
      message: error instanceof Error ? error.message : 'unknown',
    });
  }

  /**
   * Makes a single logical LLM call, retrying on failure per the configured
   * policy. Fails fast if the breaker is open or the signal is already
   * aborted. Rejects with a normalized LLMError on exhausted retries.
   *
   * When `tools` is set, returns a `CallWithToolsResult<T>` instead of `T`:
   * `{ type: 'content', content }` or `{ type: 'tool_calls', toolCalls,
   * content? }`. VernLLM never executes tools; run them yourself and
   * continue via `history` (see `ConversationTurn`). Mutually exclusive
   * with `jsonSchema`/`schema`.
   *
   * TypeScript only picks the tools-aware overload when `tools` is
   * statically present on `params`. If set conditionally on a plain
   * `CallParams<T>`, use `isToolCallResult()` to check the shape at
   * runtime instead. See the Tool Calling docs for details.
   *
   * The same static-vs-dynamic caveat applies to `stream`: TypeScript only
   * selects the streaming overload (returning `StreamCallResult<...>`) when
   * `stream: true` is statically present on `params`. A `stream` value set
   * conditionally on a plain `CallParams<T>` still resolves to `Promise<T>`
   * (or `Promise<CallWithToolsResult<T>>`) at the type level even though
   * the actual runtime result is the `{ chunks, finalResult }` streaming
   * shape whenever `stream` evaluates to `true`, callers doing this should
   * narrow/cast accordingly rather than relying on the static return type.
   *
   * @param params System/user content plus per-call overrides. See `CallParams`.
   * @returns Without `tools` or `stream`: the parsed response, or raw
   * string if `jsonMode` is false. With `tools`: a `CallWithToolsResult<T>`.
   * With `stream: true` (statically): a `{ chunks, finalResult }`
   * `StreamCallResult`, `finalResult` resolving to whichever of the above
   * shapes applies once the stream completes. See `StreamCallResult`.
   */
  async call<T = unknown>(
    params: StreamEnabledCallParams<T> & ToolEnabledCallParams<T>,
  ): Promise<StreamCallResult<CallWithToolsResult<T>>>;

  async call<T = unknown>(params: StreamEnabledCallParams<T>): Promise<StreamCallResult<T>>;

  async call<T = unknown>(params: ToolEnabledCallParams<T>): Promise<CallWithToolsResult<T>>;

  async call<T = unknown>(params: CallParams<T>): Promise<T>;

  async call<T = unknown>(
    params: CallParams<T>,
  ): Promise<T | CallWithToolsResult<T> | StreamCallResult<T | CallWithToolsResult<T>>> {
    if (params.signal?.aborted) {
      throw new LLMError('LLM request aborted', 'aborted');
    }

    const requestId = params.requestId ?? randomUUID();

    this.executor.assertBreakerClosed(params.model);

    if (params.stream) {
      // Same breaker/logging treatment as non-streaming, applied around
      // opening the stream; mid-stream failures are handled separately
      // inside the executor. Usage refund/report is deferred onto
      // finalResult, since call() must return { chunks, finalResult }
      // before the real outcome is known.
      return withReservedUsageForStream(
        params,
        () => this.executor.runStream(params, requestId),
        params.signal,
        (logMessage, error) => this.logRefundError(logMessage, error),
      );
    }

    return withReservedUsage(
      params,
      false,
      () => this.executor.run(params, requestId),
      params.signal,
      (logMessage, error) => this.logRefundError(logMessage, error),
    );
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
   * automatically get retry/timeout/circuit-breaker behavior. `reserveUsage`/
   * `refundUsage` are read from the top-level params only. Concurrent misses
   * for the same `cacheKey` share a single in-flight call, avoiding cache
   * stampedes. Supports `stream: true` and `tools` in any combination.
   *
   * When `call.tools` is set, this caches the whole `CallWithToolsResult`,
   * including `tool_calls` results, not just final answers. Whether
   * that's appropriate depends on the tool: caching "the model decided to
   * call get_weather" is usually fine to reuse briefly, but caching a
   * decision made under permissions or account state that can change
   * between calls is not. Use a short `ttl` or a separate `cacheKey` for
   * such tools if this distinction matters.
   *
   * There is no public way to cache an arbitrary non-LLM function through
   * `VernLLM`. This method always composes with `call()`. For
   * general-purpose caching unrelated to an LLM call, use a dedicated
   * caching library at the application level instead.
   *
   * @param params `cacheKey`, `ttl`, and optional
   * `reserveUsage`/`refundUsage`/`signal`, plus `call`, the `CallParams`
   * (optionally with `tools` and/or `stream`) to pass through to
   * `this.call(...)`. The top-level `signal` governs the cached operation
   * and its usage hooks only; to also abort the underlying provider
   * request, set `signal` inside `call`.
   * @returns The cached value on a hit, or the freshly-called result on a miss.
   */
  async cachedCall<T>(
    params: CachedStreamToolCallParams<T>,
  ): Promise<StreamCallResult<CallWithToolsResult<T>>>;

  async cachedCall<T>(params: CachedStreamCallParams<T>): Promise<StreamCallResult<T>>;

  async cachedCall<T>(params: CachedToolCallParams<T>): Promise<CallWithToolsResult<T>>;

  async cachedCall<T>(params: CachedCallParams<T>): Promise<T>;

  async cachedCall<T>(
    params:
      | CachedCallParams<T>
      | CachedToolCallParams<T>
      | CachedStreamCallParams<T>
      | CachedStreamToolCallParams<T>,
  ): Promise<T | CallWithToolsResult<T> | StreamCallResult<T | CallWithToolsResult<T>>> {
    const { call: callParams, ...cacheParams } = params;

    const { reserveUsage, refundUsage, ...restCallParams } = callParams;

    if (reserveUsage || refundUsage) {
      this.logger.warn(
        '[VernLLM] reserveUsage/refundUsage on `call` are ignored by cachedCall; set them at the top level instead.',
      );
    }

    if (restCallParams.stream) {
      const streamParams = restCallParams as StreamEnabledCallParams<T>;

      return this.cacheOrchestrator.runCachedStream(
        {
          ...cacheParams,
          openStream: () => this.call(streamParams),
        },
        Boolean(restCallParams.tools),
      );
    }

    return this.runCached({
      ...cacheParams,
      fn: () => this.call(restCallParams),
    });
  }

  /**
   * @param model With `circuitBreaker.isolateByModel` on, returns that
   * model's own circuit state instead of the shared one. Ignored
   * otherwise. Omit for the shared circuit (the default) or, under
   * isolation, the state of calls that didn't resolve a model.
   * @returns The current circuit breaker state (`'closed' | 'open' |
   * 'half-open'`), or undefined if no circuit breaker was configured.
   */
  getCircuitState(model?: string) {
    return this.executor.getCircuitState(model);
  }
}
