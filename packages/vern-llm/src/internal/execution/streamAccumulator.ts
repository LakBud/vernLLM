import { normalizeError } from './errors.utils.js';
import { withChunkIdleTimeout } from './retry.utils.js';

import type { Logger } from '../../logger.js';
import type { LLMError } from '../../types/errors.js';
import type {
  CallWithToolsResult,
  StreamChunk,
  TokenUsage,
  WireStreamChunk,
  WireToolCall,
} from '../../types/index.js';

/** Everything `buildStreamResult` needs beyond the raw iterator and first chunk. */
export interface StreamAccumulatorOptions<T> {
  requestId: string;
  model: string;
  providerName: string;
  /** Whether this attempt ran on a fallback target rather than the primary, mirroring `extractUsage`'s `usedFallback`. */
  isFallback: boolean;
  /** Per-call override, falling back to the instance default, mirroring every other per-call timeout. */
  chunkIdleTimeoutMs: number | undefined;
  streamController: AbortController;
  logger: Logger;
  /** External signal, forwarded to `normalizeError` so a transport error during an already-aborted call is reported as `'aborted'`, not whatever the transport itself threw. */
  signal?: AbortSignal;
  /**
   * Fires once, synchronously, right after the transport-level loop
   * finishes successfully, before `finalize` runs. Lets the caller record
   * circuit-breaker success and release rate-limiter capacity before the
   * (possibly failing) finalization step.
   */
  onStreamSuccess: (usage: TokenUsage | undefined) => void;
  /**
   * Fires once when the transport-level loop itself fails (idle timeout
   * or a transport error), before this stream's `finalResult` rejects.
   * `normalized.type === 'timeout'` is the one mid-stream failure that
   * should trip the breaker: otherwise a provider that hangs after one
   * chunk would always record a success and never open it.
   */
  onStreamFailure: (normalized: LLMError, usage: TokenUsage | undefined) => void;
  /**
   * Produces the final `T | CallWithToolsResult<T>` from the accumulated
   * text and tool-call deltas once the stream completes. Errors thrown
   * here are assumed already normalized and usage-failure-reported by the
   * caller (mirrors `finalizeResponse`'s own contract).
   */
  finalize: (
    textAcc: string,
    wireToolCalls: WireToolCall[] | undefined,
    usage: TokenUsage | undefined,
  ) => T | CallWithToolsResult<T>;
}

/**
 * The streaming accumulator: wraps the raw `WireStreamChunk` iterator in
 * an async generator that yields translated `StreamChunk`s to the caller
 * live, as they arrive, with no per-chunk timeout and no bound on total
 * duration, and accumulates text/tool-call deltas internally so that
 * `finalize` can produce `finalResult` once the stream completes.
 *
 * Two separate try/catches: the iteration loop's catch handles errors
 * the transport itself throws, which aren't normalized yet, so that
 * happens here, alongside the one `onStreamFailure` call for them. The
 * second catch, around `finalize`, does not re-normalize or re-report,
 * since `finalize`'s caller (`finalizeResponse`) already does both
 * internally.
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
    streamController,
    logger,
    signal,
  } = options;

  let resolveFinal!: (value: T | CallWithToolsResult<T>) => void;
  let rejectFinal!: (error: unknown) => void;

  const finalResult = new Promise<T | CallWithToolsResult<T>>((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });

  // Avoid an unhandled-rejection warning for callers that only read `chunks`.
  finalResult.catch(() => {});

  // Push-based, not a pulled generator, so the pump always drives
  // `finalResult` to completion even if `chunks` is never read. Buffer
  // size (not "has anyone started iterating yet") is what caps memory,
  // since the pump can outrace the caller starting iteration.
  const MAX_BUFFERED_CHUNKS = 10_000;
  const buffered: StreamChunk[] = [];
  const pending: Array<{
    resolve: (result: IteratorResult<StreamChunk>) => void;
    reject: (error: unknown) => void;
  }> = [];
  let streamDone = false;
  let streamError: unknown;
  let hasLoggedEviction = false;

  const push = (chunk: StreamChunk) => {
    const waiter = pending.shift();

    if (waiter) {
      waiter.resolve({ done: false, value: chunk });
      return;
    }

    buffered.push(chunk);

    if (buffered.length > MAX_BUFFERED_CHUNKS * 2) {
      // Nothing else surfaces this: without a log, a caller that never
      // read (or fell behind on) `chunks` has no way to tell eviction,
      // not a provider or transport bug, is why chunks are missing.
      // Logged once per stream, not on every crossing, so an ignored
      // high-volume stream doesn't spam dozens of near-identical lines.
      if (!hasLoggedEviction) {
        hasLoggedEviction = true;
        logger.warn(
          `[VernLLM] stream chunk buffer exceeded cap (${MAX_BUFFERED_CHUNKS}), evicting ` +
            `${buffered.length - MAX_BUFFERED_CHUNKS} oldest chunk(s); buffered=${buffered.length}. ` +
            'The chunks iterable was never read (or fell far behind) for this stream.',
        );
      }

      // Trim back down to the cap in one batch operation instead of
      // `shift()`ing a single element off on every push once the cap is
      // reached. A per-push `shift()` here is O(current length) in the
      // worst case, cheap for a handful of calls, but that cost is
      // paid on *every* push for the remainder of an ignored stream,
      // and its real-world cost isn't a stable, engine-independent
      // property: benchmarking this exact pattern at a similar backing
      // -array size showed multi-second stalls for what should be
      // sub-millisecond work. Letting the array grow to 2x the cap
      // before trimming amortizes the O(n) `splice` across
      // `MAX_BUFFERED_CHUNKS` pushes, so the average cost per push
      // stays O(1) regardless of how far past the cap the array is
      // allowed to grow before trimming.
      buffered.splice(0, buffered.length - MAX_BUFFERED_CHUNKS);
    }
  };

  const finish = () => {
    streamDone = true;

    for (const waiter of pending.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  };

  const fail = (error: unknown) => {
    streamDone = true;
    streamError = error;

    for (const waiter of pending.splice(0)) {
      waiter.reject(error);
    }
  };

  const chunks: AsyncIterable<StreamChunk> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<StreamChunk>> {
          if (buffered.length) {
            return Promise.resolve({ done: false, value: buffered.shift() as StreamChunk });
          }

          if (streamDone) {
            return streamError
              ? Promise.reject(streamError)
              : Promise.resolve({ done: true, value: undefined });
          }

          return new Promise((resolve, reject) => {
            pending.push({ resolve, reject });
          });
        },
      };
    },
  };

  const toolCallAcc = new Map<number, { id?: string; name?: string; args: string }>();

  let textAcc = '';
  let usage: TokenUsage | undefined;

  // Fires immediately, not lazily, so it always drives finalResult to
  // completion regardless of whether the caller reads chunks.
  void (async () => {
    try {
      let result: IteratorResult<WireStreamChunk> = first;

      while (!result.done) {
        const wireChunk = result.value;

        if (wireChunk.type === 'ping') {
          // No content to accumulate or push. Just resolving here
          // resets the idle-timeout clock on the next .next() call.
        } else if (wireChunk.type === 'text-delta') {
          textAcc += wireChunk.delta;
          push({ type: 'text-delta', delta: wireChunk.delta });
        } else if (wireChunk.type === 'tool_call_delta') {
          const entry = toolCallAcc.get(wireChunk.index) ?? { args: '' };

          entry.id ??= wireChunk.id;
          entry.name ??= wireChunk.name;
          entry.args += wireChunk.argumentsDelta ?? '';
          toolCallAcc.set(wireChunk.index, entry);

          push({
            type: 'tool_call_delta',
            index: wireChunk.index,
            id: wireChunk.id,
            name: wireChunk.name,
            argsDelta: wireChunk.argumentsDelta,
            complete: wireChunk.complete,
          });
        } else if (wireChunk.type === 'usage') {
          usage = {
            promptTokens: wireChunk.usage.prompt_tokens ?? 0,
            completionTokens: wireChunk.usage.completion_tokens ?? 0,
            totalTokens: wireChunk.usage.total_tokens ?? 0,
            requestId,
            model,
            provider: providerName,
            usedFallback: isFallback,
          };
          push({ type: 'usage', usage });
        }

        result = await withChunkIdleTimeout(
          () => iterator.next(),
          chunkIdleTimeoutMs,
          () => streamController.abort(),
          logger,
        );
      }
    } catch (error) {
      // Best-effort cleanup for a processing-time throw (as opposed to
      // `iterator.next()` rejecting, which usually means the adapter's
      // own generator already cleaned up). Two independent layers,
      // since neither is guaranteed to reach every SDK on its own:
      //
      // 1. `iterator.return()`: `iterator` is the async generator
      //    returned by the adapter's `createStream`, and every
      //    adapter's `createStream` body is a `for await...of` over
      //    the SDK's raw stream. Calling `.return()` on a generator
      //    suspended inside a `for await...of` forwards `.return()` to
      //    the iterable being iterated, standard IteratorClose
      //    behavior, so this one call closes the whole chain down to
      //    the SDK's own stream, as long as the SDK's stream
      //    implements `.return()` (true for every adapter here, see
      //    the "propagates .return()" test in each adapter's stream
      //    unit tests).
      // 2. `streamController.abort()`: aborts the same signal every
      //    adapter received for this call. SDKs that honor an
      //    AbortSignal for the life of the request, arguably the more
      //    common pattern than implementing custom `.return()`
      //    forwarding, get closed this way even if layer 1 has nothing
      //    to forward to.
      try {
        await iterator.return?.();
      } catch {
        // Cleanup failing isn't the error being reported; swallow it.
      }
      streamController.abort();

      const normalized = normalizeError(error, signal);

      try {
        options.onStreamFailure(normalized, usage);
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
      options.onStreamSuccess(usage);
    } catch {
      // A throwing callback must not stop finalize/resolveFinal below from
      // running; the stream itself still completed successfully.
    }

    try {
      const wireToolCalls: WireToolCall[] | undefined = toolCallAcc.size
        ? [...toolCallAcc.entries()]
            .sort(([indexA], [indexB]) => indexA - indexB)
            .map(([, entry]) => ({
              id: entry.id ?? '',
              type: 'function' as const,
              function: { name: entry.name ?? '', arguments: entry.args },
            }))
        : undefined;

      const finalized = options.finalize(textAcc, wireToolCalls, usage);

      resolveFinal(finalized);
    } catch (error) {
      // finalize's caller has already normalized this error and
      // reported the usage failure internally. Just propagate it.
      rejectFinal(error);
    }
  })();

  return { chunks, finalResult };
}
