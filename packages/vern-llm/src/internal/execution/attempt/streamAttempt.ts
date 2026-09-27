import { LLMError } from '../../../types/errors.js';
import { finalizeResponse } from '../responseFinalizer.js';
import { buildStreamResult } from '../streamAccumulator.js';
import { normalizeError } from '../utils/errors.utils.js';
import { toTokenUsage } from '../utils/response/usage.utils.js';
import { withChunkIdleTimeout, withTimeout } from '../utils/retry/retry.utils.js';
import {
  countsTowardBreaker,
  finalizeDependencies,
  prepareTargetAttempt,
  type AttemptArgs,
  type AttemptEnvironment,
} from './attemptEnvironment.js';
import { dispatchToProvider, reactToRateLimitError } from './providerDispatch.js';

import type { Logger } from '../../../logger.js';
import type { RateLimiterAdapter } from '../../../rateLimit.js';
import type { CallWithToolsResult, StreamChunk, WireStreamChunk } from '../../../types/index.js';

type WireUsageChunk = Extract<WireStreamChunk, { type: 'usage' }>['usage'];

/**
 * Opens a stream for one attempt. The timeout covers `createStream` and the
 * first `next()` together, since a generator does no work until pulled.
 *
 * The attempt succeeds once the first content chunk arrives, so a failure
 * before that is retried and can fall back. A stream holds its connection for
 * its whole life, so capacity is released on completion, not on open.
 */
export async function executeStreamCall<T>(
  env: AttemptEnvironment,
  args: AttemptArgs<T>,
  onOpened?: () => void,
): Promise<{
  chunks: AsyncIterable<StreamChunk>;
  finalResult: Promise<T | CallWithToolsResult<T>>;
}> {
  const { params, requestId, attempt, gateway } = args;
  const completions = env.client.chat.completions;

  if (!completions.createStream) {
    throw new LLMError(
      'stream: true requires a client/adapter with createStream',
      'invalid_params',
      {
        code: 'unsupported_capability',
        issues: { capability: 'createStream' },
      },
    );
  }

  const createStream = completions.createStream.bind(completions);

  const {
    request,
    model,
    useJson,
    state,
    release: acquiredRelease,
    dispatch,
  } = await prepareTargetAttempt(env, args);
  let release = acquiredRelease;

  // One controller for the whole stream, threaded into the transport, so an
  // idle timeout mid-way also tears the connection down.
  const streamController = new AbortController();
  const combinedExternal = params.signal
    ? AbortSignal.any([params.signal, streamController.signal])
    : streamController.signal;

  try {
    const chunkIdleTimeoutMs = params.chunkIdleTimeoutMs ?? env.chunkIdleTimeoutMs;
    let opened!: {
      head: IteratorResult<WireStreamChunk>;
      rest: AsyncIterator<WireStreamChunk>;
    };

    await dispatchToProvider(env, dispatch, params.signal, async () => {
      const { iterator, first } = await withTimeout(
        async (attemptSignal) => {
          const streamIterator = createStream(request, { signal: attemptSignal })[
            Symbol.asyncIterator
          ]();
          let firstResult = await streamIterator.next();

          // A hint comes from headers, before any body. Counting it as the
          // open would skip retries and fallback on a failed first chunk.
          while (!firstResult.done && firstResult.value.type === 'rate_limit_hint') {
            env.limiter?.reactToRateLimitHint(firstResult.value.hint);
            firstResult = await streamIterator.next();
          }

          return { iterator: streamIterator, first: firstResult };
        },
        env.timeoutMs,
        combinedExternal,
      );

      // A ping counts as open, so a thinking phase longer than `timeoutMs`
      // only needs pings to stay open.
      if (!first.done) onOpened?.();

      // Until content arrives nothing has reached the caller, so a failure is
      // still an ordinary attempt failure. The idle timeout bounds the wait.
      // Read inside `dispatch`, so its hooks see the attempt settle where it
      // succeeds or fails, not at a keep-alive ping.
      opened = await readUntilContent(
        iterator,
        first,
        chunkIdleTimeoutMs,
        streamController,
        env.limiter,
        env.logger,
        (wireUsage, error) => {
          const usage = toTokenUsage(wireUsage, {
            requestId,
            model,
            providerName: env.providerName,
            isFallback: env.isFallback,
          });
          const normalized = normalizeError(error, params.signal, undefined, env.maxRetryAfterMs);

          if (normalized.type !== 'aborted') {
            env.usageReporter.reportFailure(
              usage,
              normalized,
              attempt,
              gateway.buildAttemptContext(attempt, params.signal, state),
              true,
            );
          }

          release?.(env.usageReporter.actualTokensFor(usage));
          release = undefined;
        },
      );
    });

    const { head, rest } = opened;

    // Same error as an empty non-streaming response, so retry treats both alike.
    if (head.done) {
      throw new LLMError('Empty LLM response', 'api');
    }

    // Snapshot: `release` is cleared below once ownership passes to the stream.
    const releaseAtOpen = release;

    const result = buildStreamResult(rest, head, {
      requestId,
      model,
      providerName: env.providerName,
      isFallback: env.isFallback,
      chunkIdleTimeoutMs,
      readerStallTimeoutMs: env.readerStallTimeoutMs,
      streamController,
      logger: env.logger,
      signal: params.signal,
      maxRetryAfterMs: env.maxRetryAfterMs,
      onRateLimitHint: (hint) => {
        env.limiter?.reactToRateLimitHint(hint);
      },
      onStreamSuccess: (_usage) => {
        // Nothing here: `finalize` decides success, since its shaping or
        // soft failure check can still reject the response.
      },
      onStreamFailure: (normalized, usage) => {
        // A 429 can also arrive after the stream opened.
        reactToRateLimitError(env.limiter, normalized);

        // Only an idle timeout trips the breaker mid-stream, or a provider
        // that hangs after one chunk would never open it.
        if (normalized.type === 'timeout') {
          gateway.recordFailure(attempt, params.signal, state, normalized.code);
        } else {
          gateway.releaseTrial(attempt, params.signal, state);
        }

        if (usage && normalized.type !== 'aborted') {
          env.usageReporter.reportFailure(
            usage,
            normalized,
            attempt,
            gateway.buildAttemptContext(attempt, params.signal, state),
            true,
          );
        }

        releaseAtOpen?.(env.usageReporter.actualTokensFor(usage));
      },
      finalize: (textAcc, wireToolCalls, usage, thinking) => {
        const actualTokens = env.usageReporter.actualTokensFor(usage);

        try {
          const finalized = finalizeResponse(
            textAcc,
            wireToolCalls,
            params,
            useJson,
            usage,
            requestId,
            attempt,
            state,
            finalizeDependencies(env, gateway, model),
            false,
            thinking,
          );

          releaseAtOpen?.(actualTokens, true);

          return finalized;
        } catch (error) {
          // Free the slot without growing AIMD for a rejected response.
          releaseAtOpen?.(actualTokens);

          // The retry loop already saw this attempt succeed when the stream
          // opened, so the breaker outcome is recorded here.
          if (error instanceof LLMError && countsTowardBreaker(error)) {
            gateway.recordFailure(attempt, params.signal, state, error.code);
          } else {
            gateway.releaseTrial(attempt, params.signal, state);
          }

          throw error;
        }
      },
    });

    release = undefined;

    return result;
  } finally {
    // Only reached with a live release when opening the stream threw.
    release?.();
  }
}

/**
 * Reads past pings and rate limit hints until the first content chunk or the
 * end. A usage chunk seen on the way is replayed ahead of that content. On
 * failure the stream is closed and any usage seen goes to `onFailedUsage`.
 * Runs inside `dispatchToProvider`, which feeds the error to AIMD.
 */
async function readUntilContent(
  iterator: AsyncIterator<WireStreamChunk>,
  first: IteratorResult<WireStreamChunk>,
  chunkIdleTimeoutMs: number | undefined,
  streamController: AbortController,
  limiter: RateLimiterAdapter | undefined,
  logger: Logger,
  onFailedUsage: (usage: WireUsageChunk, error: unknown) => void,
): Promise<{ head: IteratorResult<WireStreamChunk>; rest: AsyncIterator<WireStreamChunk> }> {
  const held: WireStreamChunk[] = [];
  let current = first;

  try {
    while (!current.done && !isContentChunk(current.value)) {
      const chunk = current.value;

      if (chunk.type === 'rate_limit_hint') {
        limiter?.reactToRateLimitHint(chunk.hint);
      } else if (chunk.type !== 'ping') {
        held.push(chunk);
      }

      current = await withChunkIdleTimeout(
        () => iterator.next(),
        chunkIdleTimeoutMs,
        () => streamController.abort(),
        logger,
      );
    }
  } catch (error) {
    // Not awaited: after an idle timeout the generator can still be stuck in
    // its own await, and `return()` would wait for it. The abort is what
    // tears the transport down.
    streamController.abort();
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => {});

    const lastUsage = [...held].reverse().find((chunk) => chunk.type === 'usage');
    if (lastUsage?.type === 'usage') onFailedUsage(lastUsage.usage, error);

    throw error;
  }

  if (current.done || held.length === 0) return { head: current, rest: iterator };

  // Replays the held chunks, then the content chunk, then the live stream.
  const queue: WireStreamChunk[] = [...held.slice(1), current.value];
  const rest: AsyncIterator<WireStreamChunk> = {
    next: () => {
      const queued = queue.shift();
      return queued ? Promise.resolve({ done: false, value: queued }) : iterator.next();
    },
    return: async () => iterator.return?.() ?? { done: true, value: undefined },
  };

  return { head: { done: false, value: held[0]! }, rest };
}

/** Text or a tool call delta: the first chunk that reaches the caller as content. */
function isContentChunk(chunk: WireStreamChunk): boolean {
  return chunk.type === 'text-delta' || chunk.type === 'tool_call_delta';
}
