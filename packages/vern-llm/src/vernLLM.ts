import { randomUUID } from 'crypto';

import { CacheOrchestrator } from './internal/cache/cacheOrchestrator.js';
import { buildCircuitBreaker, makeEventReporter } from './internal/circuitBreaker.utils.js';
import { CallExecutor } from './internal/execution/callExecutor.js';
import { normalizeError } from './internal/execution/errors.utils.js';
import { withReservedUsage, withReservedUsageForStream } from './internal/execution/usage.utils.js';
import { createSafeLogger } from './internal/logger.utils.js';
import { ConsoleLogger, type Logger } from './logger.js';
import { RateLimiter } from './rateLimit.js';
import {
  InMemoryCacheAdapter,
  LLMError,
  FallbackExhaustedError,
  defaultFallbackOn,
  type CachedCallParams,
  type CachedStreamCallParams,
  type CachedStreamConditionalToolCallParams,
  type CachedStreamToolCallParams,
  type CachedConditionalToolCallParams,
  type CachedToolCallParams,
  type CachedJsonModeDisabledCallParams,
  type CachedJsonModeEnabledCallParams,
  type CallParams,
  type CallWithToolsResult,
  type ConditionalToolCallParams,
  type ContentResult,
  type FallbackAttempt,
  type FallbackOn,
  type FallbackTarget,
  type JsonModeDisabledCallParams,
  type JsonModeEnabledCallParams,
  type JsonValue,
  type StreamCallResult,
  type StreamJsonModeDisabledCallParams,
  type StreamJsonModeEnabledCallParams,
  type CachedStreamJsonModeDisabledCallParams,
  type CachedStreamJsonModeEnabledCallParams,
  type TargetCircuitState,
  type CircuitTarget,
  type StreamEnabledCallParams,
  type ToolEnabledCallParams,
  type ToolsDisabledCallParams,
  type VernLLMEvent,
  type VernLLMOptions,
} from './types/index.js';

import type { CircuitState } from './circuitBreaker.js';
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
   * One `CallExecutor` per provider target: index 0 is the primary,
   * everything after it is a `fallback` target, in the order declared.
   * Each owns its own request building, retry/timeout, circuit breaker,
   * and rate limiter. `call()` walks this array in `runFallbackChain`,
   * moving to the next entry only when `fallbackOn` says to.
   */
  private readonly executors: CallExecutor[];

  /** Decides whether a failed target is followed by the next one or the chain stops. See `VernLLMOptions['fallbackOn']`. */
  private readonly fallbackOn: FallbackOn;

  /** Reports a `'fallback'` event when the chain moves to the next target. Shared `onEvent` plumbing, same as every executor's. */
  private readonly reportEvent: (event: VernLLMEvent) => void;

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
    this.logger = createSafeLogger(options.logger ?? new ConsoleLogger(options.debug ?? false));

    const providerName = options.name ?? 'primary';

    this.cacheOrchestrator = new CacheOrchestrator(
      options.cache ?? new InMemoryCacheAdapter(),
      this.logger,
    );

    this.fallbackOn = options.fallbackOn ?? defaultFallbackOn;
    this.reportEvent = makeEventReporter(options.onEvent, this.logger);

    // The primary target's shared knobs, resolved once here rather than
    // inline in the retry-tunable default below, since fallback targets
    // that omit a field inherit this resolved value, not the raw
    // (possibly-undefined) option.
    const primaryDefaultTemperature =
      options.defaultTemperature === undefined ? 0.2 : options.defaultTemperature;

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
      nonRetryableStatus: options.nonRetryableStatus,
      circuitBreaker: options.circuitBreaker,
      rateLimit: options.rateLimit,
    };

    const declaredFallbacks: FallbackTarget[] = Array.isArray(options.fallback)
      ? options.fallback
      : options.fallback
        ? [options.fallback]
        : [];

    const targets = [primaryTarget, ...declaredFallbacks];

    this.executors = targets.map((target, i) => {
      const isFallback = i > 0;
      // `-1` for the primary, matching `FallbackAttempt.index`.
      const name = target.name ?? (isFallback ? `fallback[${i - 1}]` : providerName);

      // Built before the executor: onStateChange fires from inside the
      // breaker itself, which the executor is merely handed a reference to.
      const breaker = buildCircuitBreaker(
        target.circuitBreaker,
        name,
        target.model,
        options.onEvent,
        this.logger,
      );

      return new CallExecutor(name, target.client, target.model, {
        maxRetries: target.maxRetries ?? options.maxRetries ?? 1,
        timeoutMs: target.timeoutMs ?? options.timeoutMs ?? 25_000,
        chunkIdleTimeoutMs: target.chunkIdleTimeoutMs ?? options.chunkIdleTimeoutMs ?? 30_000,
        baseDelayMs: target.baseDelayMs ?? options.baseDelayMs ?? 500,
        defaultMaxTokens: target.defaultMaxTokens ?? options.defaultMaxTokens ?? 1000,
        defaultTemperature:
          target.defaultTemperature === undefined
            ? primaryDefaultTemperature
            : target.defaultTemperature,
        nonRetryableStatus: target.nonRetryableStatus ??
          options.nonRetryableStatus ?? [400, 401, 403, 404, 422],
        parseJson: options.parseJson,
        logger: this.logger,
        redact: options.redact,
        onUsage: options.onUsage,
        onUsageFailure: options.onUsageFailure,
        onEvent: options.onEvent,
        breaker,
        limiter: target.rateLimit ? new RateLimiter(target.rateLimit) : undefined,
        isFallback,
      });
    });
  }

  /** Logs a failed refundUsage attempt via the configured logger. */
  private logRefundError(logMessage: string, error: unknown): void {
    this.logger.error(logMessage, {
      message: error instanceof Error ? error.message : 'unknown',
    });
  }

  /**
   * Walks `this.executors` in order, running `attempt` against each until
   * one succeeds or every target has failed. `run` on a lone target
   * (no `fallback` configured) throws exactly what it throws today: the
   * loop's single iteration path is unchanged from pre-fallback behavior.
   *
   * For streaming, `attempt` is `executor.runStream`, whose own retries
   * only cover *opening* the stream (see `CallExecutor.runStream`). A
   * mid-stream failure surfaces through `finalResult` after this function
   * has already returned, so it's never seen here and never falls over,
   * per the streaming limitation: splicing a second model's output into a
   * response the consumer has already partially rendered would corrupt
   * it.
   */
  private async runFallbackChain<R>(
    params: Pick<CallParams<unknown>, 'model' | 'signal'>,
    requestId: string,
    attempt: (executor: CallExecutor, onAttempt: () => void) => Promise<R>,
    skipBreakerCheckForFirst = false,
  ): Promise<{ result: R; executor: CallExecutor; index: number; attemptCount: number }> {
    const attempts: FallbackAttempt[] = [];

    for (let i = 0; i < this.executors.length; i++) {
      const executor = this.executors[i]!;
      const startedAt = Date.now();
      let attemptCount = 0;

      try {
        // Already checked once, before usage was reserved, when this is
        // the sole target (see `call()`). `assertClosed` claims a
        // half-open trial slot as a side effect on a non-throwing call,
        // so it must run exactly once per logical call: checking it
        // again here for the same executor could either falsely see
        // "trial already in flight" (from the check that just claimed
        // it) or double-claim a slot no concurrent caller actually has.
        if (!(i === 0 && skipBreakerCheckForFirst)) {
          executor.assertBreakerClosed(params.model);
        }

        const result = await attempt(executor, () => {
          attemptCount += 1;
        });
        return { result, executor, index: i, attemptCount };
      } catch (error) {
        const normalized = normalizeError(error, params.signal);

        attempts.push({
          index: i - 1,
          provider: executor.providerName,
          model: params.model ?? executor.model,
          // `.toSnapshot()`: this target's own `attempts` (from its own
          // retries, already snapshots per `CallExecutor`) come along
          // for free since `toSnapshot()` copies them as-is.
          error: normalized.toSnapshot(),
        });

        const isLast = i === this.executors.length - 1;
        // Always consult fallbackOn, including on the last target, so it
        // sees every failure and callers who log or count from inside it
        // get a complete picture. The chain still stops once the last
        // target fails regardless of what fallbackOn returns: there is no
        // next executor to fall over to.
        const policyDecision = this.fallbackOn(normalized, { isLastTarget: isLast });
        const decision = isLast ? 'stop' : policyDecision;

        if (decision === 'stop') {
          // A lone target (or a chain that stopped on its first failure)
          // throws its own error, unchanged from pre-fallback behavior.
          throw attempts.length > 1 ? new FallbackExhaustedError(attempts) : normalized;
        }

        const next = this.executors[i + 1]!;

        this.reportEvent({
          kind: 'fallback',
          requestId,
          from: executor.providerName,
          to: next.providerName,
          fromIndex: i - 1,
          toIndex: i,
          error: normalized,
          elapsedMs: Date.now() - startedAt,
        });
      }
    }

    // Unreachable: the loop above always either returns or throws before
    // running out of targets (the last iteration's `isLast` forces a
    // throw). Kept only to satisfy the return type.
    throw new LLMError('No provider targets configured', 'invalid_params');
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
   * TypeScript picks the tools-aware overload (`CallWithToolsResult<T>`)
   * when `tools` is a literal array on `params`, and the conditional-tools
   * overload (`T | CallWithToolsResult<T>`, see `ConditionalToolCallParams`)
   * when `tools` is present but statically `ToolDefinition[] | undefined`,
   * e.g. `const tools = condition ? [myTool] : undefined`. Either way, use
   * `isToolCallResult()` to narrow the result once `tools` isn't a literal
   * array: TypeScript's static type can't know from the `ConditionalToolCallParams`
   * shape alone whether tools actually ran on a given call. Only omitting
   * `tools` entirely resolves to the plain `T` overload, since then tools
   * genuinely cannot have run. See the Tool Calling docs for details.
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
   * string if `jsonMode` is false. With `tools`: a `CallWithToolsResult<T>`,
   * narrowed to `ContentResult<T>` when `toolChoice: 'none'` is set, since
   * the model is then structurally barred from returning a `tool_calls`
   * result. With `stream: true` (statically): a `{ chunks, finalResult }`
   * `StreamCallResult`, `finalResult` resolving to whichever of the above
   * shapes applies once the stream completes. See `StreamCallResult`.
   */
  async call<T = unknown>(
    params: StreamEnabledCallParams<T> & ToolsDisabledCallParams<T>,
  ): Promise<StreamCallResult<ContentResult<T>>>;

  async call<T = unknown>(
    params: StreamEnabledCallParams<T> & ToolEnabledCallParams<T>,
  ): Promise<StreamCallResult<CallWithToolsResult<T>>>;

  async call<T = unknown>(
    params: StreamEnabledCallParams<T> & ConditionalToolCallParams<T>,
  ): Promise<StreamCallResult<T | CallWithToolsResult<T>>>;

  async call(params: StreamJsonModeDisabledCallParams): Promise<StreamCallResult<string>>;

  async call(params: StreamJsonModeEnabledCallParams): Promise<StreamCallResult<JsonValue>>;

  async call<T = unknown>(params: StreamEnabledCallParams<T>): Promise<StreamCallResult<T>>;

  async call<T = unknown>(params: ToolsDisabledCallParams<T>): Promise<ContentResult<T>>;

  async call<T = unknown>(params: ToolEnabledCallParams<T>): Promise<CallWithToolsResult<T>>;

  async call<T = unknown>(
    params: ConditionalToolCallParams<T>,
  ): Promise<T | CallWithToolsResult<T>>;

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

    if (soleTarget) {
      this.executors[0]!.assertBreakerClosed(params.model);
    }

    if (params.stream) {
      // Same breaker/logging treatment as non-streaming, applied around
      // opening the stream; mid-stream failures are handled separately
      // inside the executor and never fall over (see `runFallbackChain`).
      // Usage refund/report is deferred onto finalResult, since call()
      // must return { chunks, finalResult } before the real outcome is
      // known, which is also why `params.meta` isn't populated for
      // streaming calls.
      return withReservedUsageForStream(
        params,
        async () => {
          const { result } = await this.runFallbackChain(
            params,
            requestId,
            (executor, onAttempt) => executor.runStream(params, requestId, onAttempt),
            soleTarget,
          );
          return result;
        },
        params.signal,
        (logMessage, error) => this.logRefundError(logMessage, error),
      );
    }

    return withReservedUsage(
      params,
      false,
      async () => {
        const { result, executor, index, attemptCount } = await this.runFallbackChain(
          params,
          requestId,
          (target, onAttempt) => target.run(params, requestId, onAttempt),
          soleTarget,
        );

        if (params.meta) {
          params.meta.current = {
            provider: executor.providerName,
            model: params.model ?? executor.model,
            fallbackIndex: index - 1,
            usedFallback: index > 0,
            attempts: attemptCount,
          };
        }

        return result;
      },
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

  async cachedCall<T>(
    params: CachedStreamConditionalToolCallParams<T>,
  ): Promise<StreamCallResult<T | CallWithToolsResult<T>>>;

  async cachedCall(
    params: CachedStreamJsonModeDisabledCallParams,
  ): Promise<StreamCallResult<string>>;

  async cachedCall(
    params: CachedStreamJsonModeEnabledCallParams,
  ): Promise<StreamCallResult<JsonValue>>;

  async cachedCall<T>(params: CachedStreamCallParams<T>): Promise<StreamCallResult<T>>;

  async cachedCall<T>(params: CachedToolCallParams<T>): Promise<CallWithToolsResult<T>>;

  async cachedCall<T>(
    params: CachedConditionalToolCallParams<T>,
  ): Promise<T | CallWithToolsResult<T>>;

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
   * @param target.index Which target to read. Defaults to the primary.
   * @param target.model Which model bucket to read, if the target isolates by model.
   * @returns The breaker state, or `undefined` if that target has no breaker.
   * @throws {RangeError} If `target.index` names no target. Lets a real
   * target with no breaker (`undefined`) stay distinguishable from a
   * target that doesn't exist.
   */
  getCircuitState(target?: CircuitTarget): CircuitState | undefined {
    const executor = this.resolveExecutor(target?.index ?? 0, 'getCircuitState');
    this.warnIfModelUnsupported(executor.isolateByModel, target?.model, 'getCircuitState');

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
    const executor = this.resolveExecutor(target?.index ?? 0, 'openCircuit');
    this.warnIfModelUnsupported(executor.isolateByModel, target?.model, 'openCircuit');
    executor.openCircuit(target?.model ?? executor.model);
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
    const executor = this.resolveExecutor(target?.index ?? 0, 'closeCircuit');
    this.warnIfModelUnsupported(executor.isolateByModel, target?.model, 'closeCircuit');
    executor.closeCircuit(target?.model ?? executor.model);
  }

  /** Resolves a target index so every circuit-breaker method agrees on what counts as valid. */
  private resolveExecutor(index: number, caller: string): CallExecutor {
    const executor = this.executors[index];

    if (!executor) {
      throw new RangeError(
        `${caller}: no target at index ${index} (chain has ${this.executors.length} target${this.executors.length === 1 ? '' : 's'})`,
      );
    }

    return executor;
  }

  /** Warns when `model` can't do anything on this target, so it's never silently ignored. */
  private warnIfModelUnsupported(
    isolateByModel: boolean,
    model: string | undefined,
    caller: string,
  ): void {
    if (model !== undefined && !isolateByModel) {
      this.logger.warn(
        `[VernLLM] ${caller}: \`model: '${model}'\` has no effect here. This target's circuitBreaker doesn't have isolateByModel on, so it only tracks one shared circuit regardless of \`model\`. Omit \`model\`, or set \`circuitBreaker.isolateByModel: true\` on this target if per-model tracking is what you want.`,
      );
    }
  }
}

/**
 * Identity function preserving `params`'s own precise type, unlike a `:
 * CallParams<T>` annotation, which would widen `tools` away and break the
 * `ConditionalToolCallParams<T>` overload for `tools: someCondition ?
 * [tool] : undefined`. Use it when you need `call()` params in a named,
 * reusable variable; skip it when you can pass the object inline.
 *
 * ```ts
 * const params = defineCallParams({
 *   userContent: 'What is the weather?',
 *   tools: someCondition ? [weatherTool] : undefined,
 * });
 * const result = await llm.call(params);
 * // result: unknown | CallWithToolsResult<unknown>, same as inline
 * ```
 *
 * `T` isn't a parameter here; pin it via `llm.call<T>(params)` as usual.
 * `defineCachedCallParams` is the `cachedCall()` counterpart.
 */
export function defineCallParams<P extends CallParams<unknown>>(params: P): P {
  return params;
}

/**
 * The `cachedCall()` counterpart to `defineCallParams`: preserves the
 * whole `{ cacheKey, ttl, call }` object, `call.tools` included, in one
 * named variable.
 *
 * ```ts
 * const params = defineCachedCallParams({
 *   cacheKey: 'weather-ny',
 *   ttl: 60,
 *   call: { userContent: 'What is the weather?', tools: someCondition ? [weatherTool] : undefined },
 * });
 * const result = await llm.cachedCall(params);
 * ```
 */
export function defineCachedCallParams<P extends CachedCallParams<unknown>>(params: P): P {
  return params;
}
