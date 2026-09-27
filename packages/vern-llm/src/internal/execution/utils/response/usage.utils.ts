import {
  LLMError,
  type StreamChunk,
  type TokenUsage,
  type UsageHooks,
} from '../../../../types/index.js';

/** Usage shape shared by a non-streaming response and a stream's `usage` chunk. Both wire types agree field for field. */
export interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

/** Call-level fields stamped onto every `TokenUsage`, not carried by the wire usage itself. */
export interface TokenUsageMeta {
  requestId: string;
  model: string;
  providerName: string;
  isFallback: boolean;
}

/**
 * Maps a provider's wire usage block to `TokenUsage`. Shared by
 * `usageReporter.extract` (non-streaming) and `buildStreamResult` (the
 * `usage` stream chunk), since both wire shapes are identical.
 */
export function toTokenUsage(wireUsage: WireUsage, meta: TokenUsageMeta): TokenUsage {
  const reasoningTokens = wireUsage.completion_tokens_details?.reasoning_tokens;

  return {
    promptTokens: wireUsage.prompt_tokens ?? 0,
    completionTokens: wireUsage.completion_tokens ?? 0,
    totalTokens: wireUsage.total_tokens ?? 0,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    requestId: meta.requestId,
    model: meta.model,
    provider: meta.providerName,
    usedFallback: meta.isFallback,
  };
}

/**
 * Calls `reserveUsage` if set, mapping a failure to `quota_exceeded`, or `aborted` if the signal
 * fired. Returns whether a reservation was made, so callers know to refund.
 */
async function reserve(
  params: UsageHooks,
  coalesced: boolean,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!params.reserveUsage) return false;

  try {
    await params.reserveUsage({ coalesced, signal });
    return true;
  } catch (error) {
    if (signal?.aborted) {
      throw new LLMError('LLM request aborted', 'aborted');
    }

    throw new LLMError(
      error instanceof Error ? error.message : 'Usage reservation failed',
      'quota_exceeded',
      { cause: error },
    );
  }
}

/**
 * A refund function that logs a failing refund hook instead of throwing, so it never masks the
 * original error.
 */
function makeRefund(
  params: UsageHooks,
  coalesced: boolean,
  signal: AbortSignal | undefined,
  onRefundError: (logMessage: string, error: unknown) => void,
): (logMessage: string) => Promise<void> {
  return async (logMessage: string) => {
    try {
      await params.refundUsage?.({ coalesced, signal });
    } catch (refundError) {
      onRefundError(logMessage, refundError);
    }
  };
}

/**
 * Runs `getResult` inside a usage reservation, refunding on failure or abort when a reservation was
 * made.
 */
export async function withReservedUsage<T>(
  params: UsageHooks,
  coalesced: boolean,
  getResult: () => Promise<T>,
  signal: AbortSignal | undefined,
  onRefundError: (logMessage: string, error: unknown) => void,
): Promise<T> {
  if (signal?.aborted) {
    throw new LLMError('LLM request aborted', 'aborted');
  }

  const reserved = await reserve(params, coalesced, signal);

  const refund = makeRefund(params, coalesced, signal, onRefundError);

  if (signal?.aborted) {
    if (reserved) await refund('[VernLLM] refundUsage failed after abort');
    throw new LLMError('LLM request aborted', 'aborted');
  }

  let result: T;

  try {
    result = await getResult();
  } catch (error) {
    if (reserved) await refund('[VernLLM] refundUsage failed');
    throw error;
  }

  if (signal?.aborted) {
    if (reserved) await refund('[VernLLM] refundUsage failed after abort');
    throw new LLMError('LLM request aborted', 'aborted');
  }

  return result;
}

/**
 * Streaming counterpart to `withReservedUsage`. Reserves before opening and refunds at once if
 * opening fails. Once open it returns straight away and defers the refund to `finalResult`, since
 * the outcome is only known then, well after this returns.
 */
export async function withReservedUsageForStream<T>(
  params: UsageHooks,
  openStream: () => Promise<{ chunks: AsyncIterable<StreamChunk>; finalResult: Promise<T> }>,
  signal: AbortSignal | undefined,
  onRefundError: (logMessage: string, error: unknown) => void,
): Promise<{ chunks: AsyncIterable<StreamChunk>; finalResult: Promise<T> }> {
  if (signal?.aborted) {
    throw new LLMError('LLM request aborted', 'aborted');
  }

  const reserved = await reserve(params, false, signal);
  const refund = makeRefund(params, false, signal, onRefundError);

  if (signal?.aborted) {
    if (reserved) await refund('[VernLLM] refundUsage failed after abort');
    throw new LLMError('LLM request aborted', 'aborted');
  }

  let opened: { chunks: AsyncIterable<StreamChunk>; finalResult: Promise<T> };

  try {
    opened = await openStream();
  } catch (error) {
    if (reserved) await refund('[VernLLM] refundUsage failed after stream-open failure');
    throw error;
  }

  // Stream opened. The real outcome is only known once finalResult settles,
  // so refund is attached there instead of awaited inline, this is the
  // structural difference from withReservedUsage, not an optional variant.
  const finalResult = opened.finalResult.then(
    (value) => value,
    async (error) => {
      if (reserved) await refund('[VernLLM] refundUsage failed after stream error');
      throw error;
    },
  );

  // Same rationale as the no-op catch attached where finalResult is first
  // constructed: mark this derived promise observed too, so a caller that
  // only reads `chunks` doesn't get an unhandled-rejection warning from
  // this wrapper promise either.
  finalResult.catch(() => {});

  return { chunks: opened.chunks, finalResult };
}
