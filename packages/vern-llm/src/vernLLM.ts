import { randomUUID } from 'crypto';

import { CircuitBreaker } from './circuitBreaker.js';
import {
  defaultParseJson,
  extractStatus,
  extractRetryAfterMs,
  withTimeout,
  withChunkIdleTimeout,
  getBackoffDelay,
  waitForRetry,
  describeError,
  withReservedUsage,
  withReservedUsageForStream,
  normalizeError,
  toWireTools,
  toWireToolCalls,
  parseWireToolCalls,
  buildReplayChunks,
  buildReplayChunksFromPromise,
} from './internal/vernLLM.utils.js';
import { ConsoleLogger, type Logger } from './logger.js';
import {
  InMemoryCacheAdapter,
  LLMError,
  type CacheAdapter,
  type CachedCallParams,
  type CachedStreamCallParams,
  type CachedStreamToolCallParams,
  type CachedToolCallParams,
  type CallParams,
  type CallWithToolsResult,
  type ConversationTurn,
  type LLMClient,
  type StreamCallResult,
  type StreamChunk,
  type StreamEnabledCallParams,
  type TokenUsage,
  type ToolEnabledCallParams,
  type ToolIssue,
  type VernLLMEvent,
  type VernLLMOptions,
  type WireMessage,
  type WireStreamChunk,
  type WireToolCall,
  type WireToolChoice,
} from './types/index.js';

import type { InternalCacheParams, InternalCacheStreamParams } from './internal/cache.utils.js';

/**
 * A resilient layer around an LLM chat completions client. This is VernLLM!
 *
 * Adds retry with backoff and jitter, per-attempt timeouts, an optional
 * circuit breaker, JSON parsing with optional schema validation, usage
 * tracking, and an optional response cache. All configurable, all opt-in
 * beyond sensible defaults.
 */
export class VernLLM {
  private readonly client: LLMClient;
  private readonly model: string;

  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly chunkIdleTimeoutMs: number;
  private readonly baseDelayMs: number;
  private readonly defaultMaxTokens: number;
  private readonly defaultTemperature: number | null;

  private readonly cache: CacheAdapter<unknown>;
  private readonly nonRetryableStatus: number[];

  private readonly inFlight = new Map<string, Promise<unknown>>();

  private readonly parseJson: (content: string) => unknown;
  private readonly onUsage?: VernLLMOptions['onUsage'];
  private readonly onUsageFailure?: VernLLMOptions['onUsageFailure'];

  private readonly logger: Logger;
  private readonly breaker?: CircuitBreaker;
  private readonly providerName: string;
  private readonly onEvent?: VernLLMOptions['onEvent'];

  /**
   * @param options Client, model, and tunables. Defaults: `maxRetries` 1,
   * `timeoutMs` 25000, `baseDelayMs` 500, `defaultMaxTokens` 1000,
   * `defaultTemperature` 0.2, `cache` an in-memory adapter,
   * `nonRetryableStatus` `[400, 401, 403, 404, 422]`, `debug` false.
   */
  constructor(options: VernLLMOptions) {
    this.client = options.client;
    this.model = options.model;

    this.maxRetries = options.maxRetries ?? 1;
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.chunkIdleTimeoutMs = options.chunkIdleTimeoutMs ?? 30_000;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.defaultMaxTokens = options.defaultMaxTokens ?? 1000;
    this.defaultTemperature =
      options.defaultTemperature === undefined ? 0.2 : options.defaultTemperature;

    this.cache = options.cache ?? new InMemoryCacheAdapter();
    this.nonRetryableStatus = options.nonRetryableStatus ?? [400, 401, 403, 404, 422];

    this.parseJson = options.parseJson ?? defaultParseJson;
    this.onUsage = options.onUsage;
    this.onUsageFailure = options.onUsageFailure;

    this.logger = options.logger ?? new ConsoleLogger(options.debug ?? false);
    this.providerName = options.name ?? 'primary';
    this.onEvent = options.onEvent;

    const breakerOptions =
      typeof options.circuitBreaker === 'object' ? options.circuitBreaker : undefined;
    const userOnStateChange = breakerOptions?.onStateChange;

    this.breaker = options.circuitBreaker
      ? new CircuitBreaker({
          ...breakerOptions,
          onStateChange: (from, to, consecutiveFailures, model) => {
            this.reportEvent({
              kind: 'circuit_state',
              provider: this.providerName,
              model: model ?? this.model,
              from,
              to,
              consecutiveFailures,
            });

            // A caller-supplied onStateChange would otherwise be silently
            // discarded, since the spread above is overwritten by this
            // property. Chain it instead, same try/catch treatment as
            // every other user-supplied callback so it can't break
            // breaker bookkeeping or the call that triggered it.
            if (!userOnStateChange) return;

            try {
              userOnStateChange(from, to, consecutiveFailures, model);
            } catch (error) {
              this.logger.error('[VernLLM] circuitBreaker.onStateChange failed', {
                message: error instanceof Error ? error.message : 'unknown',
              });
            }
          },
        })
      : undefined;
  }

  /** Resolves a cache key through the adapter when it supports normalization. */
  private async resolveCacheKey(key: string): Promise<string> {
    return this.cache.resolveKey ? await this.cache.resolveKey(key) : key;
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
   * TypeScript only picks the tools-aware overload when `tools` is
   * statically present on `params`. If set conditionally on a plain
   * `CallParams<T>`, use `isToolCallResult()` to check the shape at
   * runtime instead. See the Tool Calling docs for details.
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
   * string if `jsonMode` is false. With `tools`: a `CallWithToolsResult<T>`.
   * With `stream: true` (statically): a `{ chunks, finalResult }`
   * `StreamCallResult`, `finalResult` resolving to whichever of the above
   * shapes applies once the stream completes. See `StreamCallResult`.
   */
  async call<T = unknown>(
    params: StreamEnabledCallParams<T> & ToolEnabledCallParams<T>,
  ): Promise<StreamCallResult<CallWithToolsResult<T>>>;

  async call<T = unknown>(params: StreamEnabledCallParams<T>): Promise<StreamCallResult<T>>;

  async call<T = unknown>(params: ToolEnabledCallParams<T>): Promise<CallWithToolsResult<T>>;

  async call<T = unknown>(params: CallParams<T>): Promise<T>;

  async call<T = unknown>(
    params: CallParams<T>,
  ): Promise<T | CallWithToolsResult<T> | StreamCallResult<T | CallWithToolsResult<T>>> {
    // Resolved before the breaker check, matching `buildRequestPayload`'s
    // own `params.model ?? this.model` default, so both the breaker and
    // retry events for this call report the model actually in play
    // instead of always this instance's default.
    const model = params.model ?? this.model;

    this.breaker?.assertClosed(model);

    if (params.signal?.aborted) {
      throw new LLMError('LLM request aborted', 'aborted');
    }

    const requestId = params.requestId ?? randomUUID();

    if (params.stream) {
      // Same normalize/breaker/logging treatment as non-streaming, applied
      // around opening the stream; mid-stream failures are handled
      // separately in buildStreamResult. Usage refund/report is deferred
      // onto finalResult, since call() must return { chunks, finalResult }
      // before the real outcome is known.
      return withReservedUsageForStream(
        params,
        async () => {
          try {
            return await this.retryWithBackoff(
              (attempt) => this.executeStreamCall(params, requestId, attempt),
              requestId,
              model,
              params.signal,
            );
          } catch (error) {
            const normalized = normalizeError(error, params.signal);

            if (this.countsTowardBreaker(normalized)) {
              this.breaker?.recordFailure(model);
            }

            this.logger.debug(`[VernLLM:${requestId}] stream-open error:\n${describeError(error)}`);

            throw normalized;
          }
        },
        params.signal,
        (logMessage, error) => this.logRefundError(logMessage, error),
      );
    }

    return withReservedUsage(
      params,
      false,
      async () => {
        try {
          return await this.retryWithBackoff(
            (attempt) => this.executeCall(params, requestId, attempt),
            requestId,
            model,
            params.signal,
          );
        } catch (error) {
          const normalized = normalizeError(error, params.signal);

          if (this.countsTowardBreaker(normalized)) {
            this.breaker?.recordFailure(model);
          }

          this.logger.debug(`[VernLLM:${requestId}] error:\n${describeError(error)}`);

          throw normalized;
        }
      },
      params.signal,
      (logMessage, error) => this.logRefundError(logMessage, error),
    );
  }

  /**
   * Performs a single attempt: builds the request (translating `tools` to
   * wire shape when present), dispatches it with a timeout, and shapes the
   * response into `T` or a `CallWithToolsResult<T>` when `params.tools` was
   * set. Throws on an empty response (no text and no tool_calls) so the
   * retry loop treats it like any other transient failure.
   */
  private async executeCall<T>(
    params: CallParams<T>,
    requestId: string,
    attempt: number,
  ): Promise<T | CallWithToolsResult<T>> {
    const { useJson, model, request } = this.buildRequestPayload(params);

    const response = await withTimeout(
      (attemptSignal) => this.client.chat.completions.create(request, { signal: attemptSignal }),
      this.timeoutMs,
      params.signal,
    );

    // Extracted right after the response arrives, before anything else
    // touches it, so a post-response failure still gets its usage reported.
    const usage = this.extractUsage(response, requestId, model);

    // Raw and unvalidated on purpose. Extraction (including `.trim()`,
    // which throws on a non-string `content`) happens inside
    // `finalizeResponse`'s try/catch, so a malformed response still gets
    // normalized and its usage failure reported.
    const rawContent = response.choices?.[0]?.message?.content;
    const wireToolCalls = response.choices?.[0]?.message?.tool_calls;

    return this.finalizeResponse(
      rawContent,
      wireToolCalls,
      params,
      useJson,
      model,
      usage,
      requestId,
      attempt,
    );
  }

  /**
   * Shapes a fully-arrived response (content and/or tool_calls, already
   * extracted from the provider's payload) into `T` or a
   * `CallWithToolsResult<T>`. Reused by the streaming path once it has
   * buffered the full text/tool-call deltas, so there's no separate
   * parsing/validation logic for streaming.
   *
   * Normalizes and reports usage failure on error itself, so every caller
   * gets identical error handling without duplicating it.
   */
  private finalizeResponse<T>(
    rawContent: string | null | undefined,
    wireToolCalls: WireToolCall[] | undefined,
    params: CallParams<T>,
    useJson: boolean,
    model: string,
    usage: TokenUsage | undefined,
    requestId: string,
    attempt: number,
  ): T | CallWithToolsResult<T> {
    try {
      // `.trim()` runs inside this try: a malformed response shape
      // (e.g. a non-string `content`) throws here and is normalized and
      // reported like any other post-response failure.
      const content = rawContent?.trim();

      if (!content && !wireToolCalls?.length) {
        throw new LLMError('Empty LLM response', 'api');
      }

      this.logger.debug(
        `[VernLLM:${requestId}] output:\n${(content ?? `[${wireToolCalls?.length ?? 0} tool call(s)]`).slice(0, 800)}`,
      );

      if (wireToolCalls?.length) {
        if (!params.tools) {
          throw new LLMError(
            'Provider returned tool_calls but no `tools` were sent with this call.',
            'api',
          );
        }

        const toolCalls = parseWireToolCalls(wireToolCalls);

        this.validateToolCallArguments(toolCalls, params.tools);
        this.breaker?.recordSuccess(model);
        this.reportUsage(usage);

        return { type: 'tool_calls', toolCalls, ...(content ? { content } : {}) };
      }

      // No tool_calls here, so content must be present.
      const textContent = content ?? '';

      if (!useJson) {
        this.breaker?.recordSuccess(model);
        this.reportUsage(usage);

        return params.tools ? { type: 'content', content: textContent as T } : (textContent as T);
      }

      const result = this.parseAndValidate<T>(textContent, params.schema);
      this.breaker?.recordSuccess(model);
      this.reportUsage(usage);

      return params.tools ? { type: 'content', content: result } : result;
    } catch (error) {
      // Normalized first so onUsageFailure always gets a real LLMError.
      // Also covers aborted signals: normalizeError returns type
      // 'aborted' in that case.
      const normalized = normalizeError(error, params.signal);

      if (usage && normalized.type !== 'aborted') {
        this.reportUsageFailure(usage, normalized, attempt);
      }

      throw normalized;
    }
  }

  /**
   * Opens a stream for a single attempt: builds the request exactly like
   * `executeCall`, then requires `createStream` on the client (a clear
   * `validation` error if the adapter doesn't support it). The timeout
   * wraps stream construction and the first `.next()` together, not just
   * construction: calling an `async function*` returns an iterator
   * synchronously without running its body until `.next()` is first
   * invoked, so timing only construction would time an operation that's
   * always instant, not the actual connection. Both are folded into a
   * single `withTimeout` so the same abort signal reaches whatever the
   * adapter's `createStream` uses internally for its first network
   * round-trip.
   *
   * Circuit-breaker success is recorded once the stream fully completes,
   * not on the first chunk arriving, so a connection that opens but then
   * dies mid-stream isn't masked as a success (see `buildStreamResult`).
   */
  private async executeStreamCall<T>(
    params: CallParams<T>,
    requestId: string,
    attempt: number,
  ): Promise<{
    chunks: AsyncIterable<StreamChunk>;
    finalResult: Promise<T | CallWithToolsResult<T>>;
  }> {
    const { useJson, model, request } = this.buildRequestPayload(params);

    const createStream = this.client.chat.completions.createStream;

    if (!createStream) {
      throw new LLMError('stream: true requires a client/adapter with createStream', 'validation');
    }

    // One controller for the entire stream, not just opening it. Adapters
    // already thread this signal into their transport for the life of the
    // request (that's how user-initiated cancellation works today), so
    // reusing it for the idle timeout means the same abort() call that
    // fires when the stream goes idle mid-way also tears down the
    // underlying connection, instead of only rejecting VernLLM's own
    // promise while the transport stays open.
    const streamController = new AbortController();
    const combinedExternal = params.signal
      ? AbortSignal.any([params.signal, streamController.signal])
      : streamController.signal;

    const { iterator, first } = await withTimeout(
      async (attemptSignal) => {
        const streamIterator = createStream(request, { signal: attemptSignal })[
          Symbol.asyncIterator
        ]();
        const firstResult = await streamIterator.next();

        return { iterator: streamIterator, first: firstResult };
      },
      this.timeoutMs,
      combinedExternal,
    );

    // An immediately-exhausted stream (no chunks at all) is the streaming
    // equivalent of `executeCall`'s empty-response check: surface the same
    // `LLMError('Empty LLM response', 'api')` so retry behaves identically
    // whether the empty result came from a non-streaming or streaming
    // attempt.
    if (first.done) {
      throw new LLMError('Empty LLM response', 'api');
    }

    return this.buildStreamResult(
      iterator,
      first,
      params,
      useJson,
      requestId,
      model,
      attempt,
      streamController,
    );
  }

  /**
   * The streaming accumulator: wraps the raw `WireStreamChunk` iterator in
   * an async generator that yields translated `StreamChunk`s to the caller
   * live, as they arrive, with no per-chunk timeout and no bound on total
   * duration, and accumulates text/tool-call deltas internally so that
   * `finalizeResponse` can produce `finalResult` once the stream completes.
   *
   * Two separate try/catches: the iteration loop's catch handles errors
   * the transport itself throws, which aren't normalized yet, so that
   * happens here along with the one `reportUsageFailure` call for them.
   * The second catch, around `finalizeResponse`, does not re-normalize or
   * re-report since `finalizeResponse` already does both internally.
   * Circuit-breaker success is only recorded once the stream fully
   * completes, not when the first chunk arrives, so a connection that
   * opens and then dies mid-way still counts as a failure below instead
   * of masking it.
   */
  private buildStreamResult<T>(
    iterator: AsyncIterator<WireStreamChunk>,
    first: IteratorResult<WireStreamChunk>,
    params: CallParams<T>,
    useJson: boolean,
    requestId: string,
    model: string,
    attempt: number,
    streamController: AbortController,
  ): { chunks: AsyncIterable<StreamChunk>; finalResult: Promise<T | CallWithToolsResult<T>> } {
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
          this.logger.debug(
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
              provider: this.providerName,
            };
            push({ type: 'usage', usage });
          }

          result = await withChunkIdleTimeout(
            () => iterator.next(),
            params.chunkIdleTimeoutMs ?? this.chunkIdleTimeoutMs,
            () => streamController.abort(),
            this.logger,
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

        const normalized = normalizeError(error, params.signal);

        // Idle timeout is the one mid-stream failure that trips the
        // breaker: otherwise a provider that hangs after one chunk would
        // always record a success and never open it.
        if (normalized.type === 'timeout') {
          this.breaker?.recordFailure(model);
        }

        if (usage && normalized.type !== 'aborted') {
          this.reportUsageFailure(usage, normalized, attempt, true);
        }

        fail(normalized);
        rejectFinal(normalized);

        return;
      }

      finish();
      this.breaker?.recordSuccess(model);

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

        const finalized = this.finalizeResponse(
          textAcc,
          wireToolCalls,
          params,
          useJson,
          model,
          usage,
          requestId,
          attempt,
        );

        resolveFinal(finalized);
      } catch (error) {
        // finalizeResponse has already normalized this error and reported
        // the usage failure internally. Just propagate it.
        rejectFinal(error);
      }
    })();

    return { chunks, finalResult };
  }

  /**
   * Checks every `ToolCall` against the `tools` that were offered, catching
   * a hallucinated tool name and a duplicate call id before either reaches
   * the application's dispatch table, then runs each tool's
   * `argumentsSchema`, if present.
   *
   * Contract failures (unknown name, duplicate id) are collected across
   * every call and thrown together, since retrying a request that already
   * has these errors cannot help (`shouldRetry` excludes them by `code`)
   * and a caller fixing them wants to see every one, not just the first.
   * Schema failures keep the original single-error, `type: 'validation'`
   * shape: retrying can genuinely help there if the model changes its
   * arguments, and mixing that type into the aggregate would blur the two.
   */
  private validateToolCallArguments(
    toolCalls: { id: string; name: string; arguments: unknown }[],
    tools: NonNullable<CallParams<unknown>['tools']>,
  ): void {
    const known = new Map(tools.map((t) => [t.name, t]));
    const seenIds = new Set<string>();
    const toolIssues: ToolIssue[] = [];

    for (const call of toolCalls) {
      if (seenIds.has(call.id)) {
        toolIssues.push({ name: call.name, toolCallId: call.id, code: 'duplicate_tool_call_id' });
      }
      seenIds.add(call.id);

      if (!known.has(call.name)) {
        toolIssues.push({ name: call.name, toolCallId: call.id, code: 'unknown_tool' });
      }
    }

    if (toolIssues.length > 0) {
      const unknownTool = toolIssues.find((i) => i.code === 'unknown_tool');
      const primary = unknownTool
        ? `Model requested tool "${unknownTool.name}", which was not in the tools offered ([${[...known.keys()].join(', ')}]).`
        : `Duplicate tool call id "${toolIssues[0]!.toolCallId}" in the model's response.`;

      // Most responses hit exactly one issue. When there's more than one,
      // say so, since toolCalls[0]'s problem alone would otherwise read as
      // the whole story.
      const message =
        toolIssues.length > 1
          ? `${primary} (${toolIssues.length} tool call issues total, see toolIssues.)`
          : primary;

      const error = new LLMError(
        message,
        'api',
        undefined,
        undefined,
        undefined,
        undefined,
        unknownTool ? 'unknown_tool' : 'duplicate_tool_call_id',
      );
      error.toolIssues = toolIssues;
      throw error;
    }

    for (const call of toolCalls) {
      const definition = known.get(call.name);

      if (!definition?.argumentsSchema) continue;

      const result = definition.argumentsSchema.safeParse(call.arguments);

      if (!result.success) {
        throw new LLMError(
          `Arguments for tool call "${call.name}" failed validation`,
          'validation',
          undefined,
          result.error,
        );
      }
    }
  }

  /** Runs `fn`, retrying with backoff according to `shouldRetry`. */
  private async retryWithBackoff<T>(
    fn: (attempt: number) => Promise<T>,
    requestId: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await this.recoverDelay(requestId, model, attempt, lastError, signal);
        }

        return await fn(attempt);
      } catch (error) {
        lastError = error;

        if (!this.shouldRetry(error, signal)) break;
      }
    }

    throw lastError;
  }

  /**
   * Validates `history` alternates user/assistant turns, since providers
   * like Anthropic/Gemini reject or mishandle consecutive same-role turns.
   */
  private validateHistory(history: ConversationTurn[]): void {
    let previousTurn: ConversationTurn | undefined;

    for (const [index, turn] of history.entries()) {
      if (turn.role === 'tool') {
        if (previousTurn?.role !== 'assistant' || !previousTurn.toolCalls?.length) {
          throw new LLMError(
            `history[${index}] is a "tool" turn, but must immediately follow an "assistant" turn that requested tools`,
            'validation',
          );
        }

        if (!turn.toolResults?.length) {
          throw new LLMError(
            `history[${index}] is a "tool" turn but has no toolResults`,
            'validation',
          );
        }

        const requestedIds = new Set(previousTurn.toolCalls.map((tc) => tc.id));
        const resultIds = turn.toolResults.map((tr) => tr.toolCallId);

        const unknownIds = resultIds.filter((id) => !requestedIds.has(id));

        if (unknownIds.length) {
          throw new LLMError(
            `history[${index}].toolResults references unknown toolCallId(s) [${unknownIds.join(', ')}]`,
            'validation',
          );
        }

        // Catches a duplicated toolCallId that would otherwise mask a different call's missing result.
        const seenIds = new Set<string>();
        const duplicateIds = new Set<string>();

        for (const id of resultIds) {
          if (seenIds.has(id)) duplicateIds.add(id);
          seenIds.add(id);
        }

        if (duplicateIds.size) {
          throw new LLMError(
            `history[${index}].toolResults has duplicate toolCallId(s) [${[...duplicateIds].join(', ')}]`,
            'validation',
          );
        }

        const missingIds = [...requestedIds].filter((id) => !resultIds.includes(id));

        if (missingIds.length) {
          throw new LLMError(
            `history[${index}] is missing toolResults for toolCallId(s) [${missingIds.join(', ')}]`,
            'validation',
          );
        }
      } else {
        if (turn.role === previousTurn?.role) {
          throw new LLMError(
            `history must alternate user/assistant turns: consecutive "${turn.role}" turns at history[${index - 1}] and history[${index}]`,
            'validation',
          );
        }

        if (previousTurn?.role === 'assistant' && previousTurn.toolCalls?.length) {
          throw new LLMError(
            `history[${index}] follows an assistant tool request without tool results`,
            'validation',
          );
        }
      }

      previousTurn = turn;
    }

    if (previousTurn?.role === 'assistant' && previousTurn.toolCalls?.length) {
      throw new LLMError(
        'The last entry in history is an assistant tool request without tool results',
        'validation',
      );
    }

    if (previousTurn?.role === 'user') {
      throw new LLMError(
        'The last entry in history is a "user" turn, which would collide with the current userContent turn.',
        'validation',
      );
    }
  }

  /** Applies per-call defaults and shapes params into the client's request object. */
  private buildRequestPayload<T>(params: CallParams<T>) {
    const {
      systemPrompt,
      userContent,
      history = [],
      maxTokens = this.defaultMaxTokens,
      model = this.model,
      reasoningEffort,
      jsonSchema,
      tools,
      toolChoice,
    } = params;

    const temperature =
      params.temperature === undefined ? this.defaultTemperature : params.temperature;

    if (tools && tools.length === 0) {
      throw new LLMError(
        '`tools` was an empty array. This is almost always a bug (e.g. a filtered tool list ' +
          'that ended up empty). An empty `tools` array still switches on tool-call mode ' +
          '(response shape, jsonMode default, wire format) with nothing for the model to call. ' +
          'Omit `tools` entirely for a normal call, or make sure the array is non-empty.',
        'validation',
      );
    }

    if (tools) {
      const seen = new Set<string>();
      const duplicates = new Set<string>();

      for (const tool of tools) {
        if (seen.has(tool.name)) duplicates.add(tool.name);
        seen.add(tool.name);
      }

      if (duplicates.size) {
        throw new LLMError(
          `\`tools\` has duplicate name(s): [${[...duplicates].join(', ')}]. Tool names must be unique.`,
          'validation',
        );
      }
    }

    if (toolChoice && !tools) {
      throw new LLMError(
        '`toolChoice` was set without `tools`. There is nothing for it to choose between. ' +
          'Set `tools`, or remove `toolChoice`.',
        'validation',
      );
    }

    if (tools && typeof toolChoice === 'object' && !tools.some((t) => t.name === toolChoice.name)) {
      throw new LLMError(
        `toolChoice names "${toolChoice.name}", which is not in \`tools\` ([${tools.map((t) => t.name).join(', ')}]).`,
        'validation',
      );
    }

    // Defaults to false when tools are set and the caller didn't say otherwise,
    // since forcing a JSON response format alongside tool calling is unreliable
    // across providers.
    const jsonMode = params.jsonMode ?? (tools ? false : true);
    const useJson = jsonMode || Boolean(jsonSchema);

    if (params.schema && !useJson) {
      throw new LLMError(
        'schema was provided but jsonMode: false disables JSON parsing, so nothing would validate it. Remove jsonMode: false, set jsonSchema, or remove schema.',
        'validation',
      );
    }

    const responseFormat = this.buildResponseFormat(jsonSchema, useJson);

    this.validateHistory(history);

    const request = {
      model,
      ...(temperature !== null ? { temperature } : {}),
      max_tokens: maxTokens,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(tools ? { tools: toWireTools(tools) } : {}),
      ...(tools ? { tool_choice: this.buildWireToolChoice(toolChoice) } : {}),
      messages: [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        ...history.flatMap((turn): WireMessage[] => this.turnToWireMessages(turn)),
        { role: 'user' as const, content: userContent },
      ] satisfies WireMessage[],
    };

    return { useJson, model, request };
  }

  /** Maps VernLLM's app-facing `ToolChoice` onto the OpenAI-shaped wire `tool_choice`. */
  private buildWireToolChoice(toolChoice: CallParams<unknown>['toolChoice']): WireToolChoice {
    if (!toolChoice || toolChoice === 'auto') return 'auto';
    if (toolChoice === 'none' || toolChoice === 'required') return toolChoice;

    return { type: 'function', function: { name: toolChoice.name } };
  }

  /**
   * Expands one `ConversationTurn` into one or more wire messages. Plain
   * user/assistant turns map 1:1. An assistant turn with `toolCalls` maps
   * to an assistant message carrying wire-shaped `tool_calls`. A `'tool'`
   * turn expands into one wire `tool` message per `toolResult`, since
   * OpenAI-shaped wire format wants one message per tool_call_id.
   */
  private turnToWireMessages(turn: ConversationTurn): WireMessage[] {
    if (turn.role === 'tool') {
      return (turn.toolResults ?? []).map((tr) => ({
        role: 'tool' as const,
        tool_call_id: tr.toolCallId,
        content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content ?? null),
        ...(tr.isError ? { is_error: true } : {}),
      }));
    }

    if (turn.role === 'assistant' && turn.toolCalls?.length) {
      return [
        {
          role: 'assistant' as const,
          ...(turn.content ? { content: turn.content } : {}),
          tool_calls: toWireToolCalls(turn.toolCalls),
        },
      ];
    }

    return [{ role: turn.role as 'user' | 'assistant', content: turn.content ?? '' }];
  }

  /**
   * Chooses the response format: a provider-native `jsonSchema` takes
   * priority when supplied (constrains generation directly), otherwise
   * falls back to the looser `json_object` mode when JSON output is
   * requested, or no format at all for plain text responses.
   */
  private buildResponseFormat(jsonSchema: CallParams<unknown>['jsonSchema'], useJson: boolean) {
    if (jsonSchema) {
      return {
        type: 'json_schema' as const,
        json_schema: {
          name: jsonSchema.name,
          schema: jsonSchema.schema,
          strict: jsonSchema.strict ?? true,
          description: jsonSchema.description,
        },
      };
    }

    return useJson ? { type: 'json_object' as const } : undefined;
  }

  /**
   * Pulls `TokenUsage` out of a raw response, if the provider reported it.
   * Extraction doesn't depend on what happens to the response afterward, so
   * a malformed body can still yield usage if the provider's usage block
   * itself came through intact.
   */
  private extractUsage(
    response: Awaited<ReturnType<LLMClient['chat']['completions']['create']>>,
    requestId: string,
    model: string,
  ): TokenUsage | undefined {
    if (!response.usage) return undefined;

    return {
      promptTokens: response.usage.prompt_tokens ?? 0,
      completionTokens: response.usage.completion_tokens ?? 0,
      totalTokens: response.usage.total_tokens ?? 0,
      requestId,
      model,
      provider: this.providerName,
    };
  }

  /** Reports token usage for a successful call, swallowing and logging any error `onUsage` throws. */
  private reportUsage(usage: TokenUsage | undefined): void {
    if (!usage || !this.onUsage) return;

    try {
      this.onUsage(usage);
    } catch (error) {
      this.logger.error('[VernLLM] onUsage failed', {
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  /**
   * Reports token usage spent on an attempt that then failed, so it isn't
   * dropped alongside the error. Covers any error thrown after usage
   * extraction, since all of them happen only after a response (real
   * spend) already arrived. Swallows and logs any error `onUsageFailure`
   * itself throws.
   */
  private reportUsageFailure(
    usage: TokenUsage,
    error: LLMError,
    attempt: number,
    terminal = false,
  ): void {
    // Falls back to promptTokens + completionTokens if totalTokens is 0
    // (e.g. a hand-rolled client that omits the total), so the log
    // doesn't understate real spend.
    const displayTokens = usage.totalTokens || usage.promptTokens + usage.completionTokens;

    // A mid-stream failure is terminal for that call (no further attempts
    // for this stream), unlike a stream-open failure where attempt N+1 may
    // still follow. Label them differently so the log doesn't imply a
    // retry that isn't coming.
    const attemptText = terminal
      ? 'mid-stream failure (terminal, no further attempts)'
      : `attempt ${attempt + 1}/${this.maxRetries + 1}`;

    this.logger.warn(
      `[VernLLM:${usage.requestId}] usage failure, ${attemptText}: ` +
        `type=${error.type} tokens=${displayTokens}`,
    );

    if (!this.onUsageFailure) return;

    try {
      this.onUsageFailure(usage, error);
    } catch (hookError) {
      this.logger.error('[VernLLM] onUsageFailure failed', {
        message: hookError instanceof Error ? hookError.message : 'unknown',
      });
    }
  }

  /** Reports a `VernLLMEvent`, swallowing and logging any error the handler throws. */
  private reportEvent(event: VernLLMEvent): void {
    if (!this.onEvent) return;

    try {
      this.onEvent(event);
    } catch (error) {
      this.logger.error('[VernLLM] onEvent failed', {
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  /** Parses response content as JSON and validates it against `schema` when supplied. */
  private parseAndValidate<T>(content: string, schema?: CallParams<T>['schema']): T {
    let parsed: unknown;

    try {
      parsed = this.parseJson(content);
    } catch {
      throw new LLMError('Invalid JSON response', 'parse');
    }

    if (parsed === null || parsed === undefined) {
      throw new LLMError('Invalid JSON response', 'parse');
    }

    if (!schema) return parsed as T;

    const result = schema.safeParse(parsed);

    if (!result.success) {
      throw new LLMError('Schema validation failed', 'validation', undefined, result.error);
    }

    return result.data;
  }

  /**
   * Waits out the backoff delay for a retry attempt, honoring a
   * Retry-After header on the failed attempt's error when present.
   * Both Retry-After and plain exponential backoff are capped at the same
   * max delay (see `DEFAULT_MAX_DELAY_MS` in `vernLLM.utils.ts`).
   */
  private async recoverDelay(
    requestId: string,
    model: string,
    attempt: number,
    error: unknown,
    signal?: AbortSignal,
  ) {
    const retryAfterMs = extractRetryAfterMs(error);
    const delay = retryAfterMs ?? getBackoffDelay(this.baseDelayMs, attempt);
    const retryAfterHonored = retryAfterMs !== undefined;

    this.logger.warn(
      `[VernLLM:${requestId}] recovery attempt ${attempt}/${this.maxRetries}, waiting ${delay}ms` +
        (retryAfterHonored ? ' (honoring Retry-After)' : ''),
    );

    this.reportEvent({
      kind: 'retry',
      requestId,
      provider: this.providerName,
      model,
      attempt,
      maxRetries: this.maxRetries,
      delayMs: delay,
      retryAfterHonored,
      error: normalizeError(error, signal),
    });

    await waitForRetry(delay, signal);
  }

  /** Decides whether a failed attempt is worth retrying. */
  private shouldRetry(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return false;

    if (error instanceof LLMError && (error.type === 'parse' || error.type === 'validation')) {
      return false;
    }

    // Tool contract failures repeat identically on retry: the wire request
    // is byte-for-byte the same, so nothing about a retry can change
    // whether the model names a real tool or reuses a call id.
    if (
      error instanceof LLMError &&
      (error.code === 'unknown_tool' || error.code === 'duplicate_tool_call_id')
    ) {
      return false;
    }

    const status = extractStatus(error);

    return !(status !== undefined && this.nonRetryableStatus.includes(status));
  }

  /**
   * Decides whether a failed attempt should count toward the circuit
   * breaker's failure threshold. A model hallucinating a tool name or
   * reusing a call id isn't the provider being unhealthy, it's a model
   * response defect that will very likely recur regardless of provider
   * health, so it shouldn't push a healthy provider's circuit toward
   * opening. Mirrors the same reasoning `shouldRetry` already applies to
   * `parse`/`validation`/these same tool-contract codes.
   */
  private countsTowardBreaker(error: LLMError): boolean {
    if (error.type === 'validation' || error.type === 'parse' || error.type === 'aborted') {
      return false;
    }

    return error.code !== 'unknown_tool' && error.code !== 'duplicate_tool_call_id';
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
    if (!this.cache.delete) return;

    await this.cache.delete(await this.resolveCacheKey(key));
  }

  /**
   * Internal cache primitive around caller-supplied logic. Concurrent misses
   * for the same `cacheKey` share a single in-flight call, avoiding cache
   * stampedes.
   *
   * Not part of the public API. Backs the public `cachedCall()`, which
   * always composes this with `call()` so cached results get the same
   * retry/timeout/circuit-breaker guarantees as any other LLM call.
   *
   * @param params `cacheKey`, `ttl`, `fn` (the work to run on a cache
   * miss, typically `() => this.call(...)`), and optional
   * `reserveUsage`/`refundUsage`/`signal`. See `InternalCacheParams`.
   * @returns The cached value on a hit, or the result of `fn()` on a miss.
   */
  private async runCached<T>(params: InternalCacheParams<T>): Promise<T> {
    const resolvedKey = await this.resolveCacheKey(params.cacheKey);
    const resolvedParams =
      resolvedKey === params.cacheKey ? params : { ...params, cacheKey: resolvedKey };

    const cached = await this.cache.get(resolvedKey);

    if (cached.hit) return cached.value as T;

    const existing = this.inFlight.get(resolvedKey) as Promise<T> | undefined;

    if (existing) {
      return withReservedUsage(
        resolvedParams,
        true,
        () => existing,
        params.signal,
        (logMessage, error) => this.logRefundError(logMessage, error),
      );
    }

    return this.registerTrigger(resolvedParams, false);
  }

  /** Starts the shared fn() call for a cache miss and tracks it in the in-flight map until it settles. */
  private registerTrigger<T>(params: InternalCacheParams<T>, coalesced: boolean): Promise<T> {
    const resultPromise = withReservedUsage(
      params,
      coalesced,
      () => this.runAndCache(params),
      params.signal,
      (logMessage, error) => this.logRefundError(logMessage, error),
    );

    this.inFlight.set(params.cacheKey, resultPromise);

    void resultPromise
      .catch(() => {})
      .finally(() => {
        this.inFlight.delete(params.cacheKey);
      });

    return resultPromise;
  }

  /** Runs `fn` and writes its result to the cache. */
  private async runAndCache<T>(params: InternalCacheParams<T>): Promise<T> {
    const result = await params.fn();

    try {
      await this.cache.set(params.cacheKey, result, params.ttl);
    } catch (error) {
      this.logger.error('[VernLLM] cache write failed', {
        message: error instanceof Error ? error.message : 'unknown',
      });
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
   *   (the same `this.inFlight` map non-streaming `runCached` uses, so
   *   streaming and non-streaming `cachedCall`s for the same key coalesce
   *   against each other too), and `chunks` is a one-shot replay built
   *   once that promise resolves.
   */
  private async runCachedStream<T>(
    params: InternalCacheStreamParams<T>,
    hasTools: boolean,
  ): Promise<{ chunks: AsyncIterable<StreamChunk>; finalResult: Promise<T> }> {
    const resolvedKey = await this.resolveCacheKey(params.cacheKey);
    const resolvedParams =
      resolvedKey === params.cacheKey ? params : { ...params, cacheKey: resolvedKey };

    const cached = await this.cache.get(resolvedKey);

    if (cached.hit) {
      const value = cached.value as T;

      return { chunks: buildReplayChunks(value, hasTools), finalResult: Promise.resolve(value) };
    }

    const existing = this.inFlight.get(resolvedKey) as Promise<T> | undefined;

    if (existing) {
      const finalResult = withReservedUsage(
        resolvedParams,
        true,
        () => existing,
        params.signal,
        (logMessage, error) => this.logRefundError(logMessage, error),
      );

      return { chunks: buildReplayChunksFromPromise(finalResult, hasTools), finalResult };
    }

    return this.registerStreamTrigger(resolvedParams);
  }

  /**
   * Opens the shared stream for a cache miss and tracks its settled value
   * in `this.inFlight` until it resolves or rejects. Writes to the cache
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

    this.inFlight.set(params.cacheKey, inFlightResult);

    void inFlightResult
      .catch(() => {})
      .finally(() => {
        this.inFlight.delete(params.cacheKey);
      });

    const streamPromise = withReservedUsageForStream(
      params,
      async () => {
        const opened = await params.openStream();

        const trackedResult: Promise<T> = opened.finalResult.then(
          async (value) => {
            try {
              await this.cache.set(params.cacheKey, value, params.ttl);
            } catch (error) {
              this.logger.error('[VernLLM] cache write failed', {
                message: error instanceof Error ? error.message : 'unknown',
              });
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

  /** Logs a failed refundUsage attempt via the configured logger. */
  private logRefundError(logMessage: string, error: unknown): void {
    this.logger.error(logMessage, {
      message: error instanceof Error ? error.message : 'unknown',
    });
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

  async cachedCall<T>(params: CachedStreamCallParams<T>): Promise<StreamCallResult<T>>;

  async cachedCall<T>(params: CachedToolCallParams<T>): Promise<CallWithToolsResult<T>>;

  async cachedCall<T>(params: CachedCallParams<T>): Promise<T>;

  async cachedCall<T>(
    params:
      | CachedCallParams<T>
      | CachedToolCallParams<T>
      | CachedStreamCallParams<T>
      | CachedStreamToolCallParams<T>,
  ): Promise<T | CallWithToolsResult<T> | StreamCallResult<T | CallWithToolsResult<T>>> {
    const { call: callParams, ...cacheParams } = params;

    const { reserveUsage, refundUsage, ...restCallParams } = callParams;

    if (reserveUsage || refundUsage) {
      this.logger.warn(
        '[VernLLM] reserveUsage/refundUsage on `call` are ignored by cachedCall; set them at the top level instead.',
      );
    }

    if (restCallParams.stream) {
      const streamParams = restCallParams as StreamEnabledCallParams<T>;

      return this.runCachedStream(
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
   * @param model With `circuitBreaker.isolateByModel` on, returns that
   * model's own circuit state instead of the shared one. Ignored
   * otherwise. Omit for the shared circuit (the default) or, under
   * isolation, the state of calls that didn't resolve a model.
   * @returns The current circuit breaker state (`'closed' | 'open' |
   * 'half-open'`), or undefined if no circuit breaker was configured.
   */
  getCircuitState(model?: string) {
    return this.breaker?.getState(model);
  }
}
