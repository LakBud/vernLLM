import { LLMError } from '../types/errors.js';

import type { LLMClient, WireToolCall } from '../types/client.js';
import type { StreamChunk } from '../types/stream.js';
import type { CallWithToolsResult, ToolCall, ToolDefinition } from '../types/tools.js';
import type { UsageHooks } from '../types/usage.js';

/** Translates app-facing `ToolDefinition[]` into the OpenAI-shaped wire tools array. */
export function toWireTools(
  tools: ToolDefinition[],
): NonNullable<Parameters<LLMClient['chat']['completions']['create']>[0]['tools']> {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** Translates app-facing `ToolCall[]` (e.g. from a replayed assistant turn) into wire tool_calls. */
export function toWireToolCalls(toolCalls: ToolCall[]): WireToolCall[] {
  return toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function' as const,
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments ?? {}),
    },
  }));
}

/**
 * Parses the provider's wire-shaped `tool_calls` back into VernLLM's
 * `ToolCall[]`. Malformed argument JSON is a `'parse'` error, same
 * convention as malformed JSON response bodies elsewhere in VernLLM.
 */
export function parseWireToolCalls(wireToolCalls: WireToolCall[]): ToolCall[] {
  return wireToolCalls.map((wc) => {
    let parsedArgs: unknown;

    try {
      parsedArgs = wc.function.arguments.trim() ? JSON.parse(wc.function.arguments) : {};
    } catch {
      throw new LLMError(`Invalid JSON arguments for tool call "${wc.function.name}"`, 'parse');
    }

    return { id: wc.id, name: wc.function.name, arguments: parsedArgs };
  });
}

export function defaultParseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/**
 * Looks inside an unknown error value and pulls out an http status code
 * if one is present. Checks the status field first then the status code
 * field since different client libraries use different names for this.
 * Returns undefined when the error is not an object or carries no status
 */
export function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;

  const error = err as {
    status?: unknown;
    statusCode?: unknown;
  };

  if (typeof error.status === 'number') return error.status;
  if (typeof error.statusCode === 'number') return error.statusCode;

  return undefined;
}

function formatSafely(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return '[unprintable error]';
    }
  }
}

/**
 * Looks inside an unknown thrown value and pulls out a human-readable
 * description of it. Checks the `error` field first (the provider's raw
 * rejection body, JSON-stringified if possible) then falls back to the
 * message` field. Always returns a safe string, even when the thrown value
 * has hostile properties or cannot be serialized normally.
 */
export function describeError(err: unknown): string {
  if (err && typeof err === 'object') {
    try {
      const error = err as { message?: unknown; error?: unknown };

      if (error.error !== undefined) {
        return formatSafely(error.error);
      }

      if (typeof error.message === 'string') {
        return error.message;
      }
    } catch {
      // Fall through to safe string.
    }
  }

  return formatSafely(err);
}

/**
 * Runs an async function and cancels it if it takes longer than the given
 * timeout. Creates an internal abort controller that fires after the
 * timeout elapses, and combines it with any external signal the caller
 * passed in so either one can cancel the underlying call. If the internal
 * timeout triggers and the underlying operation aborts, the error is
 * converted into an LLMError with type "timeout". External cancellations
 * continue to propagate as aborted errors. The internal timer is always
 * cleared afterward, whether the function succeeds, fails, or is aborted,
 * so nothing is left running in the background.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;

  try {
    return await fn(signal);
  } catch (err) {
    if (
      controller.signal.aborted &&
      !externalSignal?.aborted &&
      err instanceof DOMException &&
      err.name === 'AbortError'
    ) {
      throw new LLMError('Request timed out', 'timeout');
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Races one `iterator.next()` call against a per-call idle timer, to
 * bound the gap *between* chunks (unlike `withTimeout`, which only bounds
 * opening the stream and its first chunk). Without this, a connection
 * that streams one chunk then hangs would never fail.
 *
 * `timeoutMs` of 0/undefined disables the check. Otherwise rejects with
 * `LLMError('timeout')` if `next()` doesn't settle in time. The clock
 * resets on every call, so the window is measured from the most recent
 * chunk, not from stream start.
 */
export function withChunkIdleTimeout<T>(
  next: () => Promise<IteratorResult<T>>,
  timeoutMs: number | undefined,
): Promise<IteratorResult<T>> {
  if (!timeoutMs || timeoutMs <= 0) {
    return next();
  }

  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new LLMError(`No stream chunk received for ${timeoutMs}ms (idle timeout)`, 'timeout'));
    }, timeoutMs);

    next().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Default cap (ms) for both exponential backoff and honored Retry-After
 * values, so a misbehaving/adversarial Retry-After can't stall a caller
 * indefinitely
 */
export const DEFAULT_MAX_DELAY_MS = 10_000;

/**
 * Looks inside an unknown error value for a Retry-After header and
 * converts it to milliseconds. Checks `.headers` first (fetch-style,
 * Headers-like with `.get()`), then `.response.headers` (axios-style,
 * plain object) since different client libraries surface headers
 * differently. Supports both the delta-seconds form ("30") and the
 * HTTP-date form ("Wed, 21 Oct 2015 07:28:00 GMT"). The result is capped
 * at maxDelayMs. Returns undefined when no usable Retry-After is present
 */
export function extractRetryAfterMs(
  err: unknown,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number | undefined {
  if (!err || typeof err !== 'object') return undefined;

  const error = err as { headers?: unknown; response?: { headers?: unknown } };
  const headers = error.headers ?? error.response?.headers;

  if (!headers || typeof headers !== 'object') return undefined;

  const getter = headers as { get?: (name: string) => string | null };

  const raw =
    typeof getter.get === 'function'
      ? getter.get('Retry-After')
      : Object.entries(headers as Record<string, string>)
          .find(([name]) => name.toLowerCase() === 'retry-after')
          ?.at(1);

  if (typeof raw !== 'string' || raw.trim() === '') return undefined;

  const trimmed = raw.trim();

  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, Math.min(Number(trimmed) * 1000, maxDelayMs));
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.min(dateMs - Date.now(), maxDelayMs));
  }

  return undefined;
}

/** Converts any thrown value into a well-typed LLMError. */
export function normalizeError(error: unknown, signal?: AbortSignal): LLMError {
  if (signal?.aborted) {
    return new LLMError('LLM request aborted', 'aborted');
  }

  if (error instanceof LLMError) return error;

  const status = extractStatus(error);
  const retryAfterMs = extractRetryAfterMs(error);

  if (status !== undefined) {
    return new LLMError('LLM request failed', 'api', status, undefined, error, retryAfterMs);
  }

  return new LLMError('LLM request failed', 'unknown', undefined, undefined, error, retryAfterMs);
}

/**
 * Exponential backoff with jitter, capped at maxDelayMs.
 * Jitter avoids thundering-herd retries when many callers back off in lockstep,
 * the cap prevents unbounded delays when maxRetries is high
 */
export function getBackoffDelay(
  baseDelayMs: number,
  attempt: number,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number {
  const exp = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  return exp / 2 + Math.random() * (exp / 2);
}

/**
 * Pauses execution for the given delay before a retry attempt. If an
 * abort signal is provided and it fires while waiting, the pending
 * timer is cancelled immediately and the wait rejects right away with
 * an aborted error instead of continuing to sit idle until the delay
 * would have finished on its own
 */
export async function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LLMError('Operation aborted', 'aborted'));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `getResult` after reserving usage, if a `reserveUsage` hook was
 * provided. `refundUsage` fires only if a reservation was actually made.
 * `onRefundError` is called (instead of throwing) whenever a refund attempt
 * itself fails, so a broken refund hook never masks the original error.
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

  let reserved = false;

  try {
    if (params.reserveUsage) {
      await params.reserveUsage({ coalesced, signal });
      reserved = true;
    }
  } catch (error) {
    if (signal?.aborted) {
      throw new LLMError('LLM request aborted', 'aborted');
    }

    throw new LLMError(
      error instanceof Error ? error.message : 'Usage reservation failed',
      'quota_exceeded',
      undefined,
      undefined,
      error,
    );
  }

  const refund = async (logMessage: string) => {
    try {
      await params.refundUsage?.({ coalesced, signal });
    } catch (refundError) {
      onRefundError(logMessage, refundError);
    }
  };

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
 * Streaming counterpart to `withReservedUsage`. `withReservedUsage` assumes
 * `getResult()` settling *is* the operation's final outcome, awaiting it
 * synchronously before reserve/refund resolve. Streaming can't satisfy that:
 * `call()` must return `{ chunks, finalResult }` as soon as the stream
 * opens, well before the real outcome (validation, schema/tool-call checks)
 * is known.
 *
 * Reserves usage before `openStream` runs, same failure mode as the
 * non-streaming path if `reserveUsage` itself throws (mapped to
 * `quota_exceeded`, nothing opened). If `openStream` itself throws (stream
 * never opened), refunds synchronously and rethrows, exactly like
 * `withReservedUsage` does today. If it succeeds, returns `{ chunks,
 * finalResult }` immediately, refund/report is deferred onto
 * `finalResult`'s continuation, since that's the only point the real
 * outcome is known. This means `onUsageFailure` (and any refund) can fire
 * well after this function itself has returned.
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

  let reserved = false;

  try {
    if (params.reserveUsage) {
      await params.reserveUsage({ coalesced: false, signal });
      reserved = true;
    }
  } catch (error) {
    if (signal?.aborted) {
      throw new LLMError('LLM request aborted', 'aborted');
    }

    throw new LLMError(
      error instanceof Error ? error.message : 'Usage reservation failed',
      'quota_exceeded',
      undefined,
      undefined,
      error,
    );
  }

  const refund = async (logMessage: string) => {
    try {
      await params.refundUsage?.({ coalesced: false, signal });
    } catch (refundError) {
      onRefundError(logMessage, refundError);
    }
  };

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

/**
 * Converts an already-known cache value back into a plausible "text" form
 * for a one-shot replay chunk: passed through unchanged if it's already a
 * string (the `jsonMode: false` case), otherwise `JSON.stringify`'d (the
 * `jsonMode: true` case, where the cached value is the *parsed* result, not
 * the original raw text). This is a reasonable reconstruction, not a
 * byte-identical replay of whatever text the model originally streamed,
 * good enough for `for await (const c of chunks)` call sites that don't
 * branch on hit vs. miss, which is the only thing a cache-hit replay needs
 * to support.
 */
function toReplayText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Builds a trivially-exhausted one-shot `chunks` iterable from an
 * already-known value, used for a `cachedCall` cache hit, where there's no
 * live generation to relay (see `VernLLM.cachedCall`'s docs). No `usage`
 * chunk is emitted: a cache hit spent no real tokens, so there's nothing to
 * report, matching how non-streaming `cachedCall` never calls `onUsage` on
 * a hit either.
 *
 * `hasTools` must reflect whether the *original* call that produced this
 * cached value had `tools` set, that's what determines whether `value` is
 * `T` directly or a `CallWithToolsResult<T>` wrapper, and it isn't
 * something that can be reliably guessed from the value's shape alone
 * (a `schema`-validated `T` could coincidentally look like a
 * `CallWithToolsResult`).
 */
export function buildReplayChunks<T>(
  value: T | CallWithToolsResult<T>,
  hasTools: boolean,
): AsyncIterable<StreamChunk> {
  const items: StreamChunk[] = [];

  if (hasTools) {
    const result = value as CallWithToolsResult<T>;

    if (result.type === 'tool_calls') {
      result.toolCalls.forEach((toolCall, index) => {
        items.push({
          type: 'tool_call_delta',
          index,
          id: toolCall.id,
          name: toolCall.name,
          argsDelta: JSON.stringify(toolCall.arguments ?? {}),
          // A replay is always the whole value in one shot, never a
          // fragment, same as Gemini's one-shot tool_call_delta chunks.
          complete: true,
        });
      });

      if (result.content) items.push({ type: 'text-delta', delta: result.content });
    } else {
      items.push({ type: 'text-delta', delta: toReplayText(result.content) });
    }
  } else {
    items.push({ type: 'text-delta', delta: toReplayText(value) });
  }

  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

/**
 * Streaming counterpart to `buildReplayChunks` for a `cachedCall` that
 * *joined* an already-in-flight call for the same key rather than
 * triggering one itself (see `runCachedStream`'s in-flight-coalescing
 * path): there's no live stream to relay (it isn't this call's stream to
 * relay, see the joiner-path comment in `runCachedStream`), but there's
 * also no value yet, only a pending promise for one. Waits for `promise`,
 * then delegates to `buildReplayChunks`. If `promise` rejects, iterating
 * `chunks` throws that same error, consistent with how a live stream's
 * `chunks` throws on a mid-stream failure.
 */
export function buildReplayChunksFromPromise<T>(
  promise: Promise<T | CallWithToolsResult<T>>,
  hasTools: boolean,
): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      const value = await promise;

      yield* buildReplayChunks(value, hasTools);
    },
  };
}
