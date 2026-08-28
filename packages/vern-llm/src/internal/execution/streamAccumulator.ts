import { createBackpressureChannel } from './utils/chunkBuffer.utils.js';
import { normalizeError } from './utils/errors.utils.js';
import { withChunkIdleTimeout } from './utils/retry.utils.js';
import { createToolCallAccumulator } from './utils/toolCallAccumulator.utils.js';
import { toTokenUsage } from './utils/usage.utils.js';

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
 * Best effort cleanup for a processing time throw (as opposed to
 * `iterator.next()` rejecting, which usually means the adapter's own
 * generator already cleaned up). Two independent layers, since neither
 * is guaranteed to reach every SDK on its own: `iterator.return()`
 * forwards standard IteratorClose behavior down through the adapter's
 * `for await...of` to the SDK's own stream, as long as that stream
 * implements `.return()`; `streamController.abort()` closes any SDK
 * that instead honors the AbortSignal threaded through `createStream`
 * for the life of the request. Cleanup failing itself is swallowed,
 * since it isn't the error being reported.
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
  const channel = createBackpressureChannel<StreamChunk>({
    capacity: MAX_BUFFERED_CHUNKS,
    logger,
    label: 'stream chunk',
  });
  const { push, finish, fail } = channel;
  const chunks = channel.iterable;

  const toolCalls = createToolCallAccumulator();

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
          push(toolCalls.apply(wireChunk));
        } else if (wireChunk.type === 'usage') {
          usage = toTokenUsage(wireChunk.usage, { requestId, model, providerName, isFallback });
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
      await closeIterator(iterator, streamController);

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
      const wireToolCalls: WireToolCall[] | undefined = toolCalls.toWireToolCalls();

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
