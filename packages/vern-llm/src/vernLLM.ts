import { randomUUID } from 'crypto';

import { CircuitBreaker } from './circuitBreaker.js';
import {
  defaultParseJson,
  extractStatus,
  withTimeout,
  getBackoffDelay,
  waitForRetry,
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
 * A resilient wrapper around an LLM chat completions client, this is VernLLM!
 *
 * Adds retry with exponential backoff and jitter, per-attempt timeouts,
 * an optional circuit breaker, JSON parsing with optional schema
 * validation, usage tracking, and an optional response cache, all
 * configurable, all opt-in beyond sensible defaults
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

  private readonly parseJson: (content: string) => unknown;
  private readonly onUsage?: VernLLMOptions['onUsage'];

  private readonly logger: Logger;
  private readonly breaker?: CircuitBreaker;

  /**
   * @param options: Client, model, and all tunables (retries, timeout,
   * backoff, cache, circuit breaker, logger, etc). See VernLLMOptions in `types.ts`
   * for individual defaults
   */
  constructor(options: VernLLMOptions) {
    this.client = options.client;
    this.model = options.model;

    const retryConfig = this.resolveRetryConfig(options);
    this.maxRetries = retryConfig.maxRetries;
    this.timeoutMs = retryConfig.timeoutMs;
    this.baseDelayMs = retryConfig.baseDelayMs;
    this.defaultMaxTokens = retryConfig.defaultMaxTokens;

    this.cache = options.cache ?? new InMemoryCacheAdapter();
    this.nonRetryableStatus = options.nonRetryableStatus ?? [400, 401, 403];

    this.parseJson = options.parseJson ?? defaultParseJson;
    this.onUsage = options.onUsage;

    this.logger = this.resolveLogger(options);
    this.breaker = this.resolveCircuitBreaker(options);
  }

  /**
   * Resolves retry/timeout/token defaults from the given options,
   * falling back to the librarys built-in defaults for anything unset
   */
  private resolveRetryConfig(options: VernLLMOptions) {
    return {
      maxRetries: options.maxRetries ?? 1,
      timeoutMs: options.timeoutMs ?? 25_000,
      baseDelayMs: options.baseDelayMs ?? 500,
      defaultMaxTokens: options.defaultMaxTokens ?? 1000,
    };
  }

  /**
   * Returns the caller supplied logger, or a console-based logger whose
   * debug output is gated by the `debug` option (defaulting to on
   * outside production)
   */
  private resolveLogger(options: VernLLMOptions): Logger {
    return (
      options.logger ?? new ConsoleLogger(options.debug ?? process.env.NODE_ENV !== 'production')
    );
  }

  /**
   * Builds a circuit breaker if `circuitBreaker` is truthy on the
   * options. Passing `true` uses default thresholds, passing an options
   * object tunes them. Returns undefined when the breaker is disabled
   */
  private resolveCircuitBreaker(options: VernLLMOptions): CircuitBreaker | undefined {
    if (!options.circuitBreaker) return undefined;

    return new CircuitBreaker(options.circuitBreaker === true ? undefined : options.circuitBreaker);
  }

  /**
   * Makes a single logical LLM call, transparently retrying on failure
   * according to the configured retry policy
   *
   * Fails fast if the circuit breaker is open or the signal is already
   * aborted, before any request is dispatched. On exhausting all
   * retries, records a circuit breaker failure and rejects with a
   * normalized LLMError
   *
   * @param params : System/user content plus per call overrides
   * (model, temperature, jsonMode, schema, signal, etc)
   * @returns The parsed and optionally schema-validated response, or
   * the raw string content when jsonMode is disabled
   */
  async call<T = unknown>(params: CallParams<T>): Promise<T> {
    this.breaker?.assertClosed();

    if (params.signal?.aborted) {
      throw new LLMError('LLM request aborted', 'aborted');
    }

    const requestId = params.requestId ?? randomUUID();

    try {
      const result = await this.retryWithBackoff(
        () => this.executeCall(params, requestId),
        requestId,
        params.signal,
      );

      return result;
    } catch (error) {
      this.breaker?.recordFailure();
      throw this.normalizeError(error, params.signal);
    }
  }

  /**
   * Runs `fn`, retrying with backoff according to `shouldRetry` policy
   * Purely mechanical: knows nothing about LLM specifics beyond the retry
   * predicate, so its testable independent of request/response shaping
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await this.recoverDelay(requestId, attempt, signal);
        }

        return await fn();
      } catch (error) {
        lastError = error;

        if (!this.shouldRetry(error, signal)) {
          break;
        }
      }
    }

    throw lastError;
  }

  /**
   * Converts any thrown value into a well-typed LLMError for the public
   * API surface. Preserves an existing LLMError as is, reports aborted
   * signals as such, classifies errors carrying an http status as
   * type api, and otherwise falls back to a generic unknown error.
   */
  private normalizeError(error: unknown, signal?: AbortSignal): LLMError {
    if (signal?.aborted) {
      return new LLMError('LLM request aborted', 'aborted');
    }

    if (error instanceof LLMError) {
      return error;
    }

    const status = extractStatus(error);

    if (status !== undefined) {
      return new LLMError('LLM request failed', 'api', status);
    }

    return new LLMError('LLM request failed', 'unknown');
  }

  /**
   * Performs a single attempt: builds the request, dispatches it with a
   * timeout, and shapes the response. Throws on an empty response so
   * the retry loop treats it like any other transient failure. Records
   * usage and a circuit breaker success before returning
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

    this.breaker?.recordSuccess();

    if (!useJson) {
      return content as T;
    }

    return this.parseAndValidate(content, params.schema);
  }

  /**
   * Anthropic and Gemini both require strict user/assistant alternation
   * (and reject or silently mishandle two consecutive same-role turns), so
   * this validates `history` up front rather than letting a malformed
   * request surface as a confusing provider-side error. Thrown as a
   * validation LLMError, which `shouldRetry` never retries, since retrying
   * the same malformed input can't succeed
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

  /**
   * Applies per call defaults and shapes the params into the request
   * object expected by the underlying client, including the resolved
   * response format. Also returns whether JSON parsing should be
   * applied to the response and which model was ultimately used
   */
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
   * Chooses the response format to send to the provider. A provider
   * native json schema takes priority when supplied, constraining
   * generation directly, otherwise falls back to the looser json
   * object mode when JSON output is requested, or no format at all
   * for plain text responses
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
   * Reports token usage to the caller supplied onUsage callback, when
   * both a callback was configured and the provider actually returned
   * usage data on this response. A no op otherwise.
   */
  private recordUsage(
    response: Awaited<ReturnType<LLMClient['chat']['completions']['create']>>,
    requestId: string,
    model: string,
  ): void {
    if (!response.usage || !this.onUsage) return;

    this.onUsage({
      promptTokens: response.usage.prompt_tokens ?? 0,
      completionTokens: response.usage.completion_tokens ?? 0,
      totalTokens: response.usage.total_tokens ?? 0,
      requestId,
      model,
    });
  }

  /**
   * Parses the raw response content as JSON and, when a schema is
   * supplied, validates the parsed value against it. Throws a parse
   * type LLMError on malformed JSON and a validation type LLMError,
   * carrying the schemas issues, on a failed validation
   */
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

    if (!schema) {
      return parsed as T;
    }

    const result = schema.safeParse(parsed);

    if (!result.success) {
      throw new LLMError('Schema validation failed', 'validation', undefined, result.error);
    }

    return result.data;
  }

  /**
   * Waits out the backoff delay for a given retry attempt, logging the
   * attempt for observability before the wait begins. Rejects early if
   * the signal aborts during the wait
   */
  private async recoverDelay(requestId: string, attempt: number, signal?: AbortSignal) {
    const delay = getBackoffDelay(this.baseDelayMs, attempt);

    this.logger.warn(
      `[vern:${requestId}] recovery attempt ${attempt}/${this.maxRetries}, waiting ${delay}ms`,
    );

    await waitForRetry(delay, signal);
  }

  /**
   * Decides whether a failed attempt is worth retrying. Never retries
   * once the signal has aborted, never retries a parse or validation
   * failure since those stem from the response content rather than a
   * transient fault, and never retries a status code the caller has
   * marked as non retryable. Retries everything else
   */
  private shouldRetry(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) {
      return false;
    }

    if (error instanceof LLMError && (error.type === 'parse' || error.type === 'validation')) {
      return false;
    }

    const status = extractStatus(error);

    if (status !== undefined && this.nonRetryableStatus.includes(status)) {
      return false;
    }

    return true;
  }

  /**
   * Removes a cached response by key when the configured cache adapter
   * supports deletion.
   *
   * Cache invalidation remains the responsibility of the caller because
   * only the application knows when cached data is stale.
   */
  async deleteCache(key: string): Promise<void> {
    if (!this.cache.delete) {
      return;
    }

    await this.cache.delete(key);
  }

  /**
   * Thin cache wrapper around caller supplied logic. `params.fn` is expected
   * to be a call that itself invokes `this.call(...)` (see `cachedLLMCall`
   * below for a convenience wrapper that wires this up automatically),
   * `cachedCall` does not itself apply retry/timeout policy.
   */
  async cachedCall<T>(params: CachedCallParams<T>): Promise<T> {
    const cached = await this.cache.get(params.cacheKey);

    if (cached.hit) {
      return cached.value as T;
    }

    try {
      await params.reserveUsage?.();

      const result = await params.fn();

      try {
        await this.cache.set(params.cacheKey, result, params.ttl);
      } catch (error) {
        this.logger.error('[VernLLM] cache write failed', {
          message: error instanceof Error ? error.message : 'unknown',
        });
      }

      return result;
    } catch (error) {
      try {
        await params.refundUsage?.();
      } catch (refundError) {
        this.logger.error('[VernLLM] refundUsage failed', {
          message: refundError instanceof Error ? refundError.message : 'unknown',
        });
      }

      throw error;
    }
  }

  /**
   * Convenience wrapper composing `call` + `cachedCall`, so cached LLM calls
   * automatically get retry/timeout/circuit-breaker behavior without callers
   * having to remember to wire `fn: () => this.call(...)` themselves
   */
  async cachedLLMCall<T>(
    params: Omit<CachedCallParams<T>, 'fn'> & { call: CallParams<T> },
  ): Promise<T> {
    const { call: callParams, ...cacheParams } = params;

    return this.cachedCall({
      ...cacheParams,
      fn: () => this.call(callParams),
    });
  }

  /**
   * Returns the current circuit breaker state, or undefined when no
   * circuit breaker was configured on this instance
   */
  getCircuitState() {
    return this.breaker?.getState();
  }
}
