import { LLMError } from '../../types/errors.js';
import { createDeferred } from '../utils/deferred.utils.js';
import { normalizeError } from './utils/errors.utils.js';
import { withChunkIdleTimeout } from './utils/retry/retry.utils.js';
import { createBackpressureChannel } from './utils/stream/chunkBuffer.utils.js';
import { createStreamAccumulation } from './utils/stream/streamAccumulation.utils.js';

import type { Logger } from '../../logger.js';
import type {
  CallWithToolsResult,
  StreamChunk,
  ThinkingBlock,
  TokenUsage,
  WireStreamChunk,
  WireToolCall,
} from '../../types/index.js';
import type { ProviderRateLimitHint } from '../utils/rate-limit/rateLimitHint.utils.js';

/** Everything `buildStreamResult` needs beyond the raw iterator and first chunk. */
export interface StreamAccumulatorOptions<T> {
  requestId: string;
  model: string;
  providerName: string;
  /** Whether this attempt ran on a fallback target rather than the primary, mirroring `extractUsage`'s `usedFallback`. */
  isFallback: boolean;
  /** Per-call override, falling back to the instance default, mirroring every other per-call timeout. */
  chunkIdleTimeoutMs: number | undefined;
  /** See `VernLLMOptions.readerStallTimeoutMs`. Off when omitted. */
  readerStallTimeoutMs?: number;
  streamController: AbortController;
  logger: Logger;
  /** External signal, forwarded to `normalizeError` so a transport error during an already-aborted call is reported as `'aborted'`, not whatever the transport itself threw. */
  signal?: AbortSignal;
  /** The target's `maxRetryAfterMs`, forwarded to `normalizeError` so a mid-stream failure gets the same retry cap. */
  maxRetryAfterMs?: number;
  /**
   * Fires once when the transport loop ends cleanly, before `finalize`. Success itself is decided
   * by `finalize`, which can still reject the response.
   */
  onStreamSuccess: (usage: TokenUsage | undefined) => void;
  /** Fires once when the transport loop fails, before `finalResult` rejects. */
  onStreamFailure: (normalized: LLMError, usage: TokenUsage | undefined) => void;
  /**
   * Fires as soon as a `rate_limit_hint` arrives. Reacting to a hint is safe whatever the attempt's
   * outcome, unlike growing the ceiling.
   */
  onRateLimitHint?: (hint: ProviderRateLimitHint) => void;
  /**
   * Builds the final result once the stream completes. Its throws are already normalized and
   * reported, as with `finalizeResponse`.
   */
  finalize: (
    textAcc: string,
    wireToolCalls: WireToolCall[] | undefined,
    usage: TokenUsage | undefined,
    thinking: ThinkingBlock[] | undefined,
  ) => T | CallWithToolsResult<T>;
}

/**
 * Cleanup after a throw while processing. Both layers run, since SDKs differ: `return()` closes a
 * stream that supports it, and `abort()` closes one that follows the signal. A cleanup failure is
 * swallowed.
 */
async function closeIterator(
  iterator: AsyncIterator<WireStreamChunk>,
  streamController: AbortController,
): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // Cleanup failing isn't the error being reported; swallow it.
  }
  streamController.abort();
}

/** Resolves once `space` does or any of `signals` aborts, whichever comes first. */
function untilSpaceOrAbort(
  space: Promise<void>,
  signals: Array<AbortSignal | undefined>,
): Promise<void> {
  const active = signals.filter((s): s is AbortSignal => s !== undefined);

  if (active.some((s) => s.aborted)) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      for (const s of active) s.removeEventListener('abort', done);
      resolve();
    };

    for (const s of active) s.addEventListener('abort', done, { once: true });
    void space.then(done);
  });
}

/**
 * Pumps wire chunks to the caller as they arrive, with no total duration bound, and builds
 * `finalResult` when the stream ends. Transport errors are normalized and reported here; `finalize`
 * errors already were.
 */
export function buildStreamResult<T>(
  iterator: AsyncIterator<WireStreamChunk>,
  first: IteratorResult<WireStreamChunk>,
  options: StreamAccumulatorOptions<T>,
): { chunks: AsyncIterable<StreamChunk>; finalResult: Promise<T | CallWithToolsResult<T>> } {
  const {
    requestId,
    model,
    providerName,
    isFallback,
    chunkIdleTimeoutMs,
    readerStallTimeoutMs,
    streamController,
    logger,
    signal,
    maxRetryAfterMs,
    onRateLimitHint,
  } = options;

  const {
    promise: finalResult,
    resolve: resolveFinal,
    reject: rejectFinal,
  } = createDeferred<T | CallWithToolsResult<T>>();

  // Avoid an unhandled-rejection warning for callers that only read `chunks`.
  finalResult.catch(() => {});

  // A push channel rather than a pulled generator, so the pump drives `finalResult` to completion
  // even if `chunks` is never read. The buffer size caps memory before a reader starts; once
  // reading, a full buffer pauses the pump. A reader that leaves early is detached and `call()`
  // aborts the stream.
  const MAX_BUFFERED_CHUNKS = 10_000;
  const channel = createBackpressureChannel<StreamChunk>({
    capacity: MAX_BUFFERED_CHUNKS,
    logger,
    label: 'stream chunk',
    stallTimeoutMs: readerStallTimeoutMs,
    stallError: () =>
      new LLMError(
        `The chunks reader stopped pulling for ${readerStallTimeoutMs}ms with a full buffer, so it was detached. finalResult still settles.`,
        'timeout',
        { code: 'reader_stall_timeout' },
      ),
  });
  const { push, finish, fail } = channel;
  const chunks = channel.iterable;

  const accumulation = createStreamAccumulation(
    { requestId, model, providerName, isFallback },
    push,
    onRateLimitHint,
  );

  // Fires immediately, not lazily, so it always drives finalResult to
  // completion regardless of whether the caller reads chunks.
  void (async () => {
    try {
      let result: IteratorResult<WireStreamChunk> = first;

      while (!result.done) {
        const space = accumulation.apply(result.value);

        // Waiting here, not inside `withChunkIdleTimeout`, so a slow reader
        // never counts as the provider going idle. An abort ends the wait, so
        // the `next()` below surfaces it even if nobody reads again.
        if (space) await untilSpaceOrAbort(space, [streamController.signal, signal]);

        // An adapter that ignores the signal would keep yielding, and the
        // call would still resolve after the caller cancelled it.
        if (signal?.aborted) throw new LLMError('LLM request aborted', 'aborted');

        result = await withChunkIdleTimeout(
          () => iterator.next(),
          chunkIdleTimeoutMs,
          () => streamController.abort(),
          logger,
        );
      }
    } catch (error) {
      await closeIterator(iterator, streamController);

      const normalized = normalizeError(error, signal, undefined, maxRetryAfterMs);

      try {
        options.onStreamFailure(normalized, accumulation.usage);
      } catch {
        // A throwing callback must not stop fail/rejectFinal from settling
        // the promises below; the stream failure itself is still reported.
      }

      fail(normalized);
      rejectFinal(normalized);

      return;
    }

    finish();

    try {
      options.onStreamSuccess(accumulation.usage);
    } catch {
      // A throwing callback must not stop finalize/resolveFinal below from
      // running; the stream itself still completed successfully.
    }

    try {
      const { text, wireToolCalls, usage, thinking } = accumulation.result();
      const finalized = options.finalize(text, wireToolCalls, usage, thinking);

      resolveFinal(finalized);
    } catch (error) {
      // finalize's caller has already normalized this error and
      // reported the usage failure internally. Just propagate it.
      rejectFinal(error);
    }
  })();

  return { chunks, finalResult };
}
