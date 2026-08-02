import { randomUUID } from 'crypto';

import { CircuitBreaker } from './circuitBreaker.js';
import {
  defaultParseJson,
  extractStatus,
  extractRetryAfterMs,
  withTimeout,
  getBackoffDelay,
  waitForRetry,
  describeError,
  withReservedUsage,
  normalizeError,
} from './internal/vernLLM.utils.js';
import { ConsoleLogger, type Logger } from './logger.js';
import {
  InMemoryCacheAdapter,
  LLMError,
  type CacheAdapter,
  type CachedCallParams,
  type CallParams,
  type ConversationTurn,
  type LLMClient,
  type VernLLMOptions,
} from './types/index.js';

/**
 * A resilient layer around an LLM chat completions client, this is VernLLM!
 *
 * Adds retry with backoff/jitter, per-attempt timeouts, an optional circuit breaker,
 * JSON parsing with optional schema validation, usage tracking, and an
 * optional response cache, all configurable, all opt-in beyond sensible
 * defaults.
 */
export class VernLLM {
  private readonly client: LLMClient;
  private readonly model: string;

  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly baseDelayMs: number;
  private readonly defaultMaxTokens: number;

  private readonly cache: CacheAdapter<unknown>;
  private readonly nonRetryableStatus: number[];

  private readonly inFlight = new Map<string, Promise<unknown>>();

  private readonly parseJson: (content: string) => unknown;
  private readonly onUsage?: VernLLMOptions['onUsage'];

  private readonly logger: Logger;
  private readonly breaker?: CircuitBreaker;

  /**
   * @param options - Client, model, and tunables. Notable defaults:
   * `maxRetries` 1, `timeoutMs` 25000, `baseDelayMs` 500 (exponential backoff
   * base), `defaultMaxTokens` 1000, `cache` an in-memory adapter,
   * `nonRetryableStatus` `[400, 401, 403, 404, 422]`, `debug` false.
   */
  constructor(options: VernLLMOptions) {
    this.client = options.client;
    this.model = options.model;

    this.maxRetries = options.maxRetries ?? 1;
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.defaultMaxTokens = options.defaultMaxTokens ?? 1000;

    this.cache = options.cache ?? new InMemoryCacheAdapter();
    this.nonRetryableStatus = options.nonRetryableStatus ?? [400, 401, 403, 404, 422];

    this.parseJson = options.parseJson ?? defaultParseJson;
    this.onUsage = options.onUsage;

    this.logger = options.logger ?? new ConsoleLogger(options.debug ?? false);
    this.breaker = options.circuitBreaker
      ? new CircuitBreaker(options.circuitBreaker === true ? undefined : options.circuitBreaker)
      : undefined;
  }

  /** Resolves a cache key through the adapter when it supports normalization. */
  private async resolveCacheKey(key: string): Promise<string> {
    return this.cache.resolveKey ? await this.cache.resolveKey(key) : key;
  }

  /**
   * Makes a single logical LLM call, retrying on failure per the configured
   * policy. Fails fast if the breaker is open or the signal is already
   * aborted. On exhausting retries, records a breaker failure and rejects
   * with a normalized LLMError.
   *
   * @param params - System/user content plus per-call overrides (model,
   * temperature, jsonMode, schema, signal, etc). See `CallParams`.
   * @returns The parsed (and optionally schema-validated) response, or the
   * raw string content when `jsonMode` is false and no `jsonSchema` is set.
   */
  async call<T = unknown>(params: CallParams<T>): Promise<T> {
    this.breaker?.assertClosed();

    if (params.signal?.aborted) {
      throw new LLMError('LLM request aborted', 'aborted');
    }

    const requestId = params.requestId ?? randomUUID();

    return withReservedUsage(
      params,
      false,
      async () => {
        try {
          return await this.retryWithBackoff(
            () => this.executeCall(params, requestId),
            requestId,
            params.signal,
          );
        } catch (error) {
          const normalized = normalizeError(error, params.signal);

          if (
            normalized.type !== 'validation' &&
            normalized.type !== 'parse' &&
            normalized.type !== 'aborted'
          ) {
            this.breaker?.recordFailure();
          }

          this.logger.debug(`[vern:${requestId}] error:\n${describeError(error)}`);

          throw normalized;
        }
      },
      params.signal,
      (logMessage, error) => this.logRefundError(logMessage, error),
    );
  }

  /** Runs `fn`, retrying with backoff according to `shouldRetry`. */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await this.recoverDelay(requestId, attempt, lastError, signal);
        }

        return await fn();
      } catch (error) {
        lastError = error;

        if (!this.shouldRetry(error, signal)) break;
      }
    }

    throw lastError;
  }

  /**
   * Performs a single attempt: builds the request, dispatches it with a
   * timeout, and shapes the response. Throws on an empty response so the
   * retry loop treats it like any other transient failure.
   */
  private async executeCall<T>(params: CallParams<T>, requestId: string): Promise<T> {
    const { useJson, model, request } = this.buildRequestPayload(params);

    const response = await withTimeout(
      (attemptSignal) => this.client.chat.completions.create(request, { signal: attemptSignal }),
      this.timeoutMs,
      params.signal,
    );

    const content = response.choices?.[0]?.message?.content?.trim();

    if (!content) {
      throw new LLMError('Empty LLM response', 'api');
    }

    this.logger.debug(`[vern:${requestId}] output:\n${content.slice(0, 800)}`);

    this.recordUsage(response, requestId, model);

    if (!useJson) {
      this.breaker?.recordSuccess();
      return content as T;
    }

    const result = this.parseAndValidate(content, params.schema);
    this.breaker?.recordSuccess();

    return result;
  }

  /**
   * Validates `history` alternates user/assistant turns, since providers
   * like Anthropic/Gemini reject or mishandle consecutive same-role turns.
   */
  private validateHistory(history: ConversationTurn[]): void {
    let previousRole: 'user' | 'assistant' | undefined;

    for (const [index, turn] of history.entries()) {
      if (turn.role !== 'user' && turn.role !== 'assistant') {
        throw new LLMError(
          `Invalid history[${index}].role "${turn.role}": must be "user" or "assistant"`,
          'validation',
        );
      }

      if (turn.role === previousRole) {
        throw new LLMError(
          `history must alternate user/assistant turns: consecutive "${turn.role}" turns at history[${index - 1}] and history[${index}]`,
          'validation',
        );
      }

      previousRole = turn.role;
    }

    if (previousRole === 'user') {
      throw new LLMError(
        'The last entry in history is a "user" turn, which would collide with the current userContent turn. history must end with an "assistant" turn (or be empty).',
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
      temperature = 0.2,
      jsonMode = true,
      maxTokens = this.defaultMaxTokens,
      model = this.model,
      reasoningEffort,
      jsonSchema,
    } = params;

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
      temperature,
      max_tokens: maxTokens,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      messages: [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        ...history.map((turn) => ({ role: turn.role, content: turn.content })),
        { role: 'user' as const, content: userContent },
      ],
    };

    return { useJson, model, request };
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

  /** Reports token usage to `onUsage`, swallowing and logging any error it throws. */
  private recordUsage(
    response: Awaited<ReturnType<LLMClient['chat']['completions']['create']>>,
    requestId: string,
    model: string,
  ): void {
    if (!response.usage || !this.onUsage) return;

    try {
      this.onUsage({
        promptTokens: response.usage.prompt_tokens ?? 0,
        completionTokens: response.usage.completion_tokens ?? 0,
        totalTokens: response.usage.total_tokens ?? 0,
        requestId,
        model,
      });
    } catch (error) {
      this.logger.error('[VernLLM] onUsage failed', {
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
    attempt: number,
    error: unknown,
    signal?: AbortSignal,
  ) {
    const retryAfterMs = extractRetryAfterMs(error);
    const delay = retryAfterMs ?? getBackoffDelay(this.baseDelayMs, attempt);

    this.logger.warn(
      `[vern:${requestId}] recovery attempt ${attempt}/${this.maxRetries}, waiting ${delay}ms` +
        (retryAfterMs !== undefined ? ' (honoring Retry-After)' : ''),
    );

    await waitForRetry(delay, signal);
  }

  /** Decides whether a failed attempt is worth retrying. */
  private shouldRetry(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return false;

    if (error instanceof LLMError && (error.type === 'parse' || error.type === 'validation')) {
      return false;
    }

    const status = extractStatus(error);

    return !(status !== undefined && this.nonRetryableStatus.includes(status));
  }

  /**
   * Removes a cached response by key when the configured cache adapter
   * supports deletion. Cache invalidation is the caller's responsibility;
   * only the application knows when cached data is stale.
   *
   * @param key - The raw cache key (resolved through the adapter's
   * `resolveKey`, if any, before deletion).
   */
  async deleteCache(key: string): Promise<void> {
    if (!this.cache.delete) return;

    await this.cache.delete(await this.resolveCacheKey(key));
  }

  /**
   * Cache wrapper around caller-supplied logic. Concurrent misses for the
   * same `cacheKey` share a single in-flight call, avoiding cache stampedes.
   *
   * @param params - `cacheKey`, `ttl`, `fn` (the work to run on a cache
   * miss, typically `() => this.call(...)`), and optional
   * `reserveUsage`/`refundUsage`/`signal`. See `CachedCallParams`.
   * @returns The cached value on a hit, or the result of `fn()` on a miss.
   */
  async cachedCall<T>(params: CachedCallParams<T>): Promise<T> {
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
  private registerTrigger<T>(params: CachedCallParams<T>, coalesced: boolean): Promise<T> {
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
  private async runAndCache<T>(params: CachedCallParams<T>): Promise<T> {
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

  /** Logs a failed refundUsage attempt via the configured logger. */
  private logRefundError(logMessage: string, error: unknown): void {
    this.logger.error(logMessage, {
      message: error instanceof Error ? error.message : 'unknown',
    });
  }

  /**
   * Convenience wrapper composing `call` + `cachedCall`, so cached LLM calls
   * automatically get retry/timeout/circuit-breaker behavior. `reserveUsage`/
   * `refundUsage` are read from the top-level params only.
   *
   * @param params - `cachedCall` params (`cacheKey`, `ttl`, etc, minus `fn`)
   * plus `call`, the `CallParams` to pass through to `this.call(...)`.
   * @returns The cached value on a hit, or the freshly-called result on a miss.
   */
  async cachedLLMCall<T>(
    params: Omit<CachedCallParams<T>, 'fn'> & { call: CallParams<T> },
  ): Promise<T> {
    const { call: callParams, ...cacheParams } = params;
    const {
      reserveUsage: innerReserveUsage,
      refundUsage: innerRefundUsage,
      ...restCallParams
    } = callParams;

    if (innerReserveUsage || innerRefundUsage) {
      this.logger.warn(
        '[VernLLM] reserveUsage/refundUsage on `call` are ignored by cachedLLMCall; set them at the top level instead.',
      );
    }

    return this.cachedCall({ ...cacheParams, fn: () => this.call(restCallParams) });
  }

  /**
   * @returns The current circuit breaker state (`'closed' | 'open' |
   * 'half-open'`), or undefined if no circuit breaker was configured.
   */
  getCircuitState() {
    return this.breaker?.getState();
  }
}
