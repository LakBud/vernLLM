import {
  withReservedUsage,
  withReservedUsageForStream,
} from '../execution/utils/response/usage.utils.js';
import { createInFlightRegistry } from './utils/inFlightRegistry.utils.js';
import { buildReplayChunks, buildReplayChunksFromPromise } from './utils/replay.utils.js';
import {
  abortableChunks,
  createSharedAbort,
  raceAbort,
  type SharedAbort,
} from './utils/sharedAbort.utils.js';

import type { Logger } from '../../logger.js';
import type { LLMError } from '../../types/errors.js';
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
  /** The shared abort owned by each in-flight promise's participants. */
  private readonly sharedAborts = new WeakMap<Promise<unknown>, SharedAbort>();

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
      stack: error instanceof Error ? error.stack : undefined,
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

  /** The shared in-flight promise for `key`, if any, so callers can wait for it to settle. */
  inFlightFor(key: string): Promise<unknown> | undefined {
    return this.inFlight.get(key);
  }

  /**
   * Returns the in-flight entry for `key` a new caller can still join, or
   * `undefined`. An entry whose shared signal already fired is doomed, so
   * it's skipped and the caller starts fresh work instead.
   */
  private joinable<T>(key: string): { promise: Promise<T>; shared: SharedAbort } | undefined {
    const promise = this.inFlight.get(key) as Promise<T> | undefined;
    if (!promise) return undefined;

    const shared = this.sharedAborts.get(promise);
    if (!shared || shared.signal.aborted) return undefined;

    return { promise, shared };
  }

  /**
   * Waits on another call's already in-flight promise instead of
   * starting a new one, reserving usage as a coalesced spend. This
   * caller's own `signal` ends only its own wait; the shared work keeps
   * running while any other participant remains.
   */
  private joinInFlight<T, P extends UsageHooks & { signal?: AbortSignal }>(
    params: P,
    existing: Promise<T>,
    shared: SharedAbort,
  ): Promise<T> {
    const release = shared.join();

    const result = withReservedUsage(
      params,
      true,
      () => raceAbort(existing, params.signal),
      params.signal,
      (logMessage, error) => this.logRefundError(logMessage, error),
    );

    void result.then(release, release);

    return result;
  }

  /**
   * Internal cache primitive around caller-supplied logic. Concurrent misses
   * for the same `cacheKey` share a single in-flight call, avoiding cache
   * stampedes. The shared call is only aborted once every caller waiting
   * on it has left.
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

    const existing = this.joinable<T>(resolvedParams.cacheKey);

    if (existing) {
      return this.joinInFlight(resolvedParams, existing.promise, existing.shared);
    }

    return this.registerTrigger(resolvedParams);
  }

  /**
   * Creates the shared deferred work for a miss and registers it
   * synchronously, so a concurrent caller always sees it in time to join.
   * `start` runs the work at most once. `fail` rejects it without running,
   * for a trigger that failed before starting and left nobody behind.
   */
  private createShared<V>(key: string, run: (signal: AbortSignal) => Promise<V>) {
    const shared = createSharedAbort();
    let resolveShared!: (value: V) => void;
    let rejectShared!: (error: unknown) => void;

    const promise = new Promise<V>((resolve, reject) => {
      resolveShared = resolve;
      rejectShared = reject;
    });

    void promise.then(shared.settle, shared.settle);
    this.sharedAborts.set(promise, shared);
    this.inFlight.track(key, promise);

    let started = false;

    // Called exactly once: by the trigger, or by `onTriggerFailed` when
    // the trigger failed before calling it.
    const start = (): Promise<V> => {
      started = true;
      const running = run(shared.signal);
      running.then(resolveShared, rejectShared);
      return running;
    };

    /**
     * Called when the trigger failed. If it never started the work, the
     * work starts anyway for any participant still waiting on an abort,
     * otherwise the shared promise fails with the trigger's error.
     */
    const onTriggerFailed = (error: unknown) => {
      if (started) return;

      // Before `start`, the trigger can only fail in usage reservation or
      // an abort check, and both throw an LLMError.
      if ((error as LLMError).type === 'aborted' && shared.participants > 0) {
        // `start` already routes a rejection into the shared promise.
        void start();
        return;
      }

      rejectShared(error);
    };

    return { shared, promise, start, onTriggerFailed };
  }

  /** Starts the shared fn() call for a cache miss and tracks it in the in-flight registry until it settles. */
  private registerTrigger<T>(params: InternalCacheParams<T>): Promise<T> {
    const { shared, promise, start, onTriggerFailed } = this.createShared<T>(
      params.cacheKey,
      (signal) => this.runAndCache(params, signal),
    );
    const release = shared.join();

    const resultPromise = withReservedUsage(
      params,
      false,
      () => raceAbort(start(), params.signal),
      params.signal,
      (logMessage, error) => this.logRefundError(logMessage, error),
    );

    void resultPromise.then(release, (error: unknown) => {
      release();
      onTriggerFailed(error);
    });

    // Observed so a shared rejection nobody else awaits stays quiet.
    promise.catch(() => {});

    return resultPromise;
  }

  /** Runs `fn` and writes its result to the cache. */
  private async runAndCache<T>(params: InternalCacheParams<T>, signal: AbortSignal): Promise<T> {
    const result = await params.fn(signal);
    await this.writeCache(params.cacheKey, result, params.ttl);
    return result;
  }

  /** Writes to the cache, logging instead of throwing on adapter failure. */
  private async writeCache(key: string, value: unknown, ttl: number): Promise<void> {
    // Still handed to the adapter, which treats it as expired on arrival and
    // drops any older value. The warning is the only sign the caller gets
    // that nothing is being cached.
    if (typeof ttl !== 'number' || Number.isNaN(ttl)) {
      this.logger.warn(
        `[VernLLM] cachedCall ttl must be a number of seconds, got ${String(ttl)}. Nothing is cached.`,
      );
    }

    try {
      await this.cache.set(key, value, ttl);
    } catch (error) {
      this.logger.warn(
        `[VernLLM] cache write failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
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

    const existing = this.joinable<T>(resolvedParams.cacheKey);

    if (existing) {
      const finalResult = this.joinInFlight(resolvedParams, existing.promise, existing.shared);

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
   * in the in-flight registry until it resolves or rejects. Writes to the
   * cache on success only, matching `runAndCache`.
   *
   * The stream runs under the shared signal, so it keeps going for any
   * joiner after the trigger aborts. The trigger's own `chunks` and
   * `finalResult` stop at the trigger's own signal.
   */
  private registerStreamTrigger<T>(
    params: InternalCacheStreamParams<T>,
  ): Promise<{ chunks: AsyncIterable<StreamChunk>; finalResult: Promise<T> }> {
    type Opened = { chunks: AsyncIterable<StreamChunk>; finalResult: Promise<T> };

    let openedStream: Promise<Opened> | undefined;

    const openShared = (signal: AbortSignal): Promise<Opened> => {
      openedStream ??= params.openStream(signal).then((opened) => ({
        chunks: opened.chunks,
        finalResult: opened.finalResult.then(async (value) => {
          // Failed calls aren't cached, matching `runAndCache`.
          await this.writeCache(params.cacheKey, value, params.ttl);
          return value;
        }),
      }));

      return openedStream;
    };

    const { shared, promise, start, onTriggerFailed } = this.createShared<T>(
      params.cacheKey,
      async (signal) => (await openShared(signal)).finalResult,
    );
    const release = shared.join();

    promise.catch(() => {});

    const streamPromise = withReservedUsageForStream(
      params,
      async () => {
        void start().catch(() => {});
        const opened = await raceAbort(openShared(shared.signal), params.signal);
        const finalResult = raceAbort(opened.finalResult, params.signal);
        finalResult.catch(() => {});

        return { chunks: abortableChunks(opened.chunks, params.signal), finalResult };
      },
      params.signal,
      (logMessage, error) => this.logRefundError(logMessage, error),
    );

    const onFailed = (error: unknown) => {
      release();
      onTriggerFailed(error);
    };

    streamPromise.then((opened) => {
      opened.finalResult.then(release, onFailed);
    }, onFailed);

    return streamPromise;
  }
}
