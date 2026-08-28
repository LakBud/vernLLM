import { withReservedUsage, withReservedUsageForStream } from '../execution/utils/usage.utils.js';
import { createInFlightRegistry } from './utils/inFlightRegistry.utils.js';
import { buildReplayChunks, buildReplayChunksFromPromise } from './utils/replay.utils.js';

import type { Logger } from '../../logger.js';
import type { CacheAdapter, StreamChunk, UsageHooks } from '../../types/index.js';
import type { InternalCacheParams, InternalCacheStreamParams } from './utils/cache.utils.js';

/**
 * Owns cache key resolution, cache reads/writes, and in-flight coalescing
 * for concurrent misses on the same key. Doesn't know about `CallExecutor`,
 * retries, or providers at all: `fn`/`openStream` are opaque callbacks
 * (`VernLLM.cachedCall` passes `() => this.call(...)`), so this class only
 * needs the cache adapter and a logger. Extracted from `VernLLM` since
 * caching and per-target call mechanics are independent concerns that
 * happened to live on the same class.
 */
export class CacheOrchestrator {
  private readonly inFlight = createInFlightRegistry<unknown>();

  constructor(
    private readonly cache: CacheAdapter<unknown>,
    private readonly logger: Logger,
  ) {}

  /** Resolves a cache key through the adapter when it supports normalization. */
  async resolveCacheKey(key: string): Promise<string> {
    return this.cache.resolveKey ? await this.cache.resolveKey(key) : key;
  }

  /**
   * Removes a cached response by key when the configured cache adapter
   * supports deletion. Cache invalidation is the caller's responsibility;
   * only the application knows when cached data is stale.
   */
  async deleteCache(key: string): Promise<void> {
    if (!this.cache.delete) return;

    try {
      await this.cache.delete(await this.resolveCacheKey(key));
    } catch (error) {
      this.logger.warn(
        `[VernLLM] cache delete failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  /** Logs a failed refundUsage attempt via the configured logger. */
  private logRefundError(logMessage: string, error: unknown): void {
    this.logger.error(logMessage, {
      message: error instanceof Error ? error.message : 'unknown',
    });
  }

  /**
   * Reads from the cache, treating a failed adapter read as a miss rather
   * than letting it fail the call. The request still falls through to a
   * real provider call, but that fallback is now logged instead of silent.
   */
  private async getCached(key: string): Promise<{ hit: boolean; value?: unknown }> {
    try {
      return await this.cache.get(key);
    } catch (error) {
      this.logger.warn(
        `[VernLLM] cache read failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );

      return { hit: false };
    }
  }

  /**
   * Resolves `params.cacheKey` and reads the cache under that key in one
   * step. Shared by `runCached` and `runCachedStream`, which otherwise
   * duplicated this exact prefix.
   */
  private async resolveKeyAndReadCache<P extends { cacheKey: string }>(
    params: P,
  ): Promise<{ resolvedParams: P; cached: { hit: boolean; value?: unknown } }> {
    const resolvedKey = await this.resolveCacheKey(params.cacheKey);
    const resolvedParams: P =
      resolvedKey === params.cacheKey ? params : { ...params, cacheKey: resolvedKey };

    return { resolvedParams, cached: await this.getCached(resolvedKey) };
  }

  /**
   * Waits on another call's already in-flight promise instead of
   * starting a new one, reserving usage as a coalesced spend. Shared by
   * `runCached` and `runCachedStream`, which otherwise duplicated this
   * exact `withReservedUsage` call.
   */
  private joinInFlight<T, P extends UsageHooks & { signal?: AbortSignal }>(
    params: P,
    existing: Promise<T>,
  ): Promise<T> {
    return withReservedUsage(
      params,
      true,
      () => existing,
      params.signal,
      (logMessage, error) => this.logRefundError(logMessage, error),
    );
  }

  /**
   * Internal cache primitive around caller-supplied logic. Concurrent misses
   * for the same `cacheKey` share a single in-flight call, avoiding cache
   * stampedes.
   *
   * Backs the public `VernLLM.cachedCall()`, which always composes this
   * with `call()` so cached results get the same retry/timeout/
   * circuit-breaker guarantees as any other LLM call.
   *
   * @param params `cacheKey`, `ttl`, `fn` (the work to run on a cache
   * miss, typically `() => this.call(...)`), and optional
   * `reserveUsage`/`refundUsage`/`signal`. See `InternalCacheParams`.
   * @returns The cached value on a hit, or the result of `fn()` on a miss.
   */
  async runCached<T>(params: InternalCacheParams<T>): Promise<T> {
    const { resolvedParams, cached } = await this.resolveKeyAndReadCache(params);

    if (cached.hit) return cached.value as T;

    const existing = this.inFlight.get(resolvedParams.cacheKey) as Promise<T> | undefined;

    if (existing) {
      return this.joinInFlight(resolvedParams, existing);
    }

    return this.registerTrigger(resolvedParams);
  }

  /** Starts the shared fn() call for a cache miss and tracks it in the in-flight registry until it settles. */
  private registerTrigger<T>(params: InternalCacheParams<T>): Promise<T> {
    const resultPromise = withReservedUsage(
      params,
      false,
      () => this.runAndCache(params),
      params.signal,
      (logMessage, error) => this.logRefundError(logMessage, error),
    );

    this.inFlight.track(params.cacheKey, resultPromise);

    return resultPromise;
  }

  /** Runs `fn` and writes its result to the cache. */
  private async runAndCache<T>(params: InternalCacheParams<T>): Promise<T> {
    const result = await params.fn();

    try {
      await this.cache.set(params.cacheKey, result, params.ttl);
    } catch (error) {
      this.logger.warn(
        `[VernLLM] cache write failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }

    return result;
  }

  /**
   * Streaming counterpart to `runCached`. Three cases:
   *
   * - Hit: no live generation to relay. Returns immediately with
   *   `finalResult` resolved to the cached value and a one-shot `chunks`
   *   replay built from it, so `for await (const c of chunks)` call sites
   *   work identically on a hit or a miss. No usage hooks fire, since
   *   nothing was actually spent.
   * - Miss, nothing else in flight for this key: delegates to
   *   `registerStreamTrigger`, which opens the stream and relays its
   *   `chunks` live.
   * - Miss, but another call for the same key is already in flight: this
   *   call has no live chunks of its own to relay, so it's treated like a
   *   delayed hit. `finalResult` shares the trigger's in-flight promise
   *   (the same in-flight registry non-streaming `runCached` uses, so
   *   streaming and non-streaming calls for the same key coalesce
   *   against each other too), and `chunks` is a one-shot replay built
   *   once that promise resolves.
   */
  async runCachedStream<T>(
    params: InternalCacheStreamParams<T>,
    hasTools: boolean,
  ): Promise<{ chunks: AsyncIterable<StreamChunk>; finalResult: Promise<T> }> {
    const { resolvedParams, cached } = await this.resolveKeyAndReadCache(params);

    if (cached.hit) {
      const value = cached.value as T;

      return { chunks: buildReplayChunks(value, hasTools), finalResult: Promise.resolve(value) };
    }

    const existing = this.inFlight.get(resolvedParams.cacheKey) as Promise<T> | undefined;

    if (existing) {
      const finalResult = this.joinInFlight(resolvedParams, existing);

      // Mirror the no-op catch in withReservedUsageForStream: buildReplayChunksFromPromise
      // doesn't await this promise until `chunks` is iterated, so a caller that only reads
      // `finalResult` eagerly (or never reads `chunks`) could otherwise trigger an
      // unhandled-rejection warning.
      finalResult.catch(() => {});

      return { chunks: buildReplayChunksFromPromise(finalResult, hasTools), finalResult };
    }

    return this.registerStreamTrigger(resolvedParams);
  }

  /**
   * Opens the shared stream for a cache miss and tracks its settled value
   * in the in-flight registry until it resolves or rejects. Writes to the cache
   * on success only, matching `runAndCache`.
   *
   * Registers the in-flight promise synchronously, before anything async
   * runs, so a concurrent `cachedCall` for the same key always sees it in
   * time to join instead of triggering its own stream. Settlement is
   * wired onto the whole `withReservedUsageForStream` call rather than a
   * line inside its callback, so any failure point (reserving usage,
   * opening the stream, or the stream itself) reliably settles the
   * in-flight entry instead of leaving it stuck.
   */
  private registerStreamTrigger<T>(
    params: InternalCacheStreamParams<T>,
  ): Promise<{ chunks: AsyncIterable<StreamChunk>; finalResult: Promise<T> }> {
    let resolveInFlight!: (value: T) => void;
    let rejectInFlight!: (error: unknown) => void;

    const inFlightResult = new Promise<T>((resolve, reject) => {
      resolveInFlight = resolve;
      rejectInFlight = reject;
    });

    this.inFlight.track(params.cacheKey, inFlightResult);

    const streamPromise = withReservedUsageForStream(
      params,
      async () => {
        const opened = await params.openStream();

        const trackedResult: Promise<T> = opened.finalResult.then(
          async (value) => {
            try {
              await this.cache.set(params.cacheKey, value, params.ttl);
            } catch (error) {
              this.logger.warn(
                `[VernLLM] cache write failed: ${error instanceof Error ? error.message : 'unknown'}`,
              );
            }

            return value;
          },
          (error: unknown) => {
            // Failed calls aren't cached, matching `runAndCache`, which
            // only calls `cache.set` after `fn()` succeeds. Rethrown
            // unchanged so both the refund logic attached downstream and
            // `inFlightResult` see the real failure.
            throw error;
          },
        );

        return { chunks: opened.chunks, finalResult: trackedResult };
      },
      params.signal,
      (logMessage, error) => this.logRefundError(logMessage, error),
    );

    // Settles `inFlightResult` (registered above) based on `streamPromise`'s
    // own outcome, not a line inside its callback. See this function's
    // docs for why.
    streamPromise.then(
      (opened) => {
        opened.finalResult.then(resolveInFlight, rejectInFlight);
      },
      (error: unknown) => {
        rejectInFlight(error);
      },
    );

    return streamPromise;
  }
}
