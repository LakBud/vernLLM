import {
  withReservedUsage,
  withReservedUsageForStream,
} from '../execution/utils/response/usage.utils.js';
import { onEarlyExit } from '../execution/utils/stream/earlyExit.utils.js';
import { createDeferred } from '../utils/deferred.utils.js';
import { errorMessage, logError } from '../utils/logger.utils.js';
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
 * Cache key resolution, reads, writes and coalescing of concurrent misses. Knows nothing about
 * providers: the work is an opaque callback from `cachedCall`.
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
      this.logger.warn(`[VernLLM] cache delete failed: ${errorMessage(error)}`);
    }
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
      this.logger.warn(`[VernLLM] cache read failed: ${errorMessage(error)}`);

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
   * Joins another caller's in-flight work, reserving usage as a coalesced spend. This caller's
   * signal only ends its own wait.
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
      (logMessage, error) => logError(this.logger, logMessage, error),
    );

    void result.then(release, release);

    return result;
  }

  /**
   * The caching core behind `cachedCall()`. Concurrent misses for one key share a single in-flight
   * call, aborted only once every waiting caller has left.
   *
   * @param params Cache settings plus `fn`, the work to run on a miss. See `InternalCacheParams`.
   * @returns The cached value on a hit, or `fn()`'s result on a miss.
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
   * Creates and registers the shared work synchronously, so a concurrent caller always sees it in
   * time to join. `start` runs it at most once.
   */
  private createShared<V>(key: string, run: (signal: AbortSignal) => Promise<V>) {
    const shared = createSharedAbort();
    const { promise, resolve: resolveShared, reject: rejectShared } = createDeferred<V>();

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
      (logMessage, error) => logError(this.logger, logMessage, error),
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
    // Never handed to the adapter: a custom one could turn a NaN expiry into
    // an entry that is never evicted. The warning is the only sign the
    // caller gets that nothing is being cached.
    if (typeof ttl !== 'number' || Number.isNaN(ttl)) {
      this.logger.warn(
        `[VernLLM] cachedCall ttl must be a number of seconds, got ${String(ttl)}. Nothing is cached.`,
      );
      return;
    }

    try {
      await this.cache.set(key, value, ttl);
    } catch (error) {
      this.logger.warn(`[VernLLM] cache write failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Streaming counterpart to `runCached`. A hit returns the cached value with a one-shot replay of
   * `chunks`, and no usage hooks fire. A miss with nothing in flight opens the stream and relays it
   * live. A miss that finds work in flight replays once it resolves; streaming and plain calls for
   * a key coalesce with each other.
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
   * Opens the shared stream for a miss and tracks it until it settles, caching on success only. The
   * stream runs under the shared signal, so joiners keep it after the trigger leaves; the trigger's
   * own `chunks` and `finalResult` stop at its signal.
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

    // Stopping `chunks` early leaves the shared stream the same way an
    // abort does: this trigger's `finalResult` rejects as aborted, and the
    // stream is cancelled only once no joiner is left waiting on it.
    const left = new AbortController();
    const triggerSignal = params.signal
      ? AbortSignal.any([params.signal, left.signal])
      : left.signal;

    const streamPromise = withReservedUsageForStream(
      params,
      async () => {
        void start().catch(() => {});
        const opened = await raceAbort(openShared(shared.signal), params.signal);
        const finalResult = raceAbort(opened.finalResult, triggerSignal);
        finalResult.catch(() => {});

        return {
          chunks: onEarlyExit(abortableChunks(opened.chunks, params.signal), () => left.abort()),
          finalResult,
        };
      },
      params.signal,
      (logMessage, error) => logError(this.logger, logMessage, error),
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
