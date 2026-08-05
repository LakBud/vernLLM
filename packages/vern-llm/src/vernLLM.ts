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
  toWireTools,
  toWireToolCalls,
  parseWireToolCalls,
} from './internal/vernLLM.utils.js';
import { ConsoleLogger, type Logger } from './logger.js';
import {
  InMemoryCacheAdapter,
  LLMError,
  type CacheAdapter,
  type CachedCallParams,
  type CachedLLMCallParams,
  type CachedLLMToolCallParams,
  type CallParams,
  type CallWithToolsResult,
  type ConversationTurn,
  type LLMClient,
  type ToolEnabledCallParams,
  type VernLLMOptions,
  type WireMessage,
  type WireToolChoice,
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
  private readonly defaultTemperature: number | null;

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
   * base), `defaultMaxTokens` 1000, `defaultTemperature` 0.2, `cache` an
   * in-memory adapter, `nonRetryableStatus` `[400, 401, 403, 404, 422]`,
   * `debug` false.
   */
  constructor(options: VernLLMOptions) {
    this.client = options.client;
    this.model = options.model;

    this.maxRetries = options.maxRetries ?? 1;
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.defaultMaxTokens = options.defaultMaxTokens ?? 1000;
    this.defaultTemperature =
      options.defaultTemperature === undefined ? 0.2 : options.defaultTemperature;

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
   * aborted. Rejects with a normalized LLMError on exhausted retries.
   *
   * When `tools` is set, returns a `CallWithToolsResult<T>` instead of `T`:
   * `{ type: 'content', content }` or `{ type: 'tool_calls', toolCalls,
   * content? }`. VernLLM never executes tools, run them yourself and
   * continue via `history` (see `ConversationTurn`). Mutually exclusive
   * with `jsonSchema`/`schema`.
   *
   * TypeScript only picks the tools-aware overload when `tools` is
   * statically present on `params`. If set conditionally on a plain
   * `CallParams<T>`, use `isToolCallResult()` to check the shape at
   * runtime instead. See the Tool Calling docs for details.
   *
   * @param params - System/user content plus per-call overrides. See `CallParams`.
   * @returns Without `tools`: the parsed response, or raw string if
   * `jsonMode` is false. With `tools`: a `CallWithToolsResult<T>`.
   */
  async call<T = unknown>(params: ToolEnabledCallParams<T>): Promise<CallWithToolsResult<T>>;

  async call<T = unknown>(params: CallParams<T>): Promise<T>;

  async call<T = unknown>(params: CallParams<T>): Promise<T | CallWithToolsResult<T>> {
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

  /**
   * Performs a single attempt: builds the request (translating `tools` to
   * wire shape when present), dispatches it with a timeout, and shapes the
   * response, either `T` directly, or a `CallWithToolsResult<T>` when
   * `params.tools` was set. Throws on an empty response (no text and no
   * tool_calls) so the retry loop treats it like any other transient
   * failure.
   */
  private async executeCall<T>(
    params: CallParams<T>,
    requestId: string,
  ): Promise<T | CallWithToolsResult<T>> {
    const { useJson, model, request } = this.buildRequestPayload(params);

    const response = await withTimeout(
      (attemptSignal) => this.client.chat.completions.create(request, { signal: attemptSignal }),
      this.timeoutMs,
      params.signal,
    );

    const content = response.choices?.[0]?.message?.content?.trim();
    const wireToolCalls = response.choices?.[0]?.message?.tool_calls;

    if (!content && !wireToolCalls?.length) {
      throw new LLMError('Empty LLM response', 'api');
    }

    this.logger.debug(
      `[vern:${requestId}] output:\n${(content ?? `[${wireToolCalls?.length ?? 0} tool call(s)]`).slice(0, 800)}`,
    );

    this.recordUsage(response, requestId, model);

    if (wireToolCalls?.length) {
      if (!params.tools) {
        throw new LLMError(
          'Provider returned tool_calls but no `tools` were sent with this call.',
          'api',
        );
      }

      const toolCalls = parseWireToolCalls(wireToolCalls);

      this.validateToolCallArguments(toolCalls, params.tools);
      this.breaker?.recordSuccess();

      return { type: 'tool_calls', toolCalls, ...(content ? { content } : {}) };
    }

    // No tool_calls at this point, so content must be present (the empty
    // check above already ruled out both being empty).
    const textContent = content ?? '';

    if (!useJson) {
      this.breaker?.recordSuccess();
      return params.tools ? { type: 'content', content: textContent as T } : (textContent as T);
    }

    const result = this.parseAndValidate<T>(textContent, params.schema);
    this.breaker?.recordSuccess();

    return params.tools ? { type: 'content', content: result } : result;
  }

  /**
   * Checks every `ToolCall` against the `tools` that were actually offered
   * (catching a hallucinated tool name early, with a clear error, instead
   * of letting it reach the application's dispatch table as a confusing
   * "undefined is not a function"), then runs each tool's
   * `argumentsSchema` (if present) and throws `LLMError('validation')` on
   * failure.
   */
  private validateToolCallArguments(
    toolCalls: { name: string; arguments: unknown }[],
    tools: NonNullable<CallParams<unknown>['tools']>,
  ): void {
    const knownNames = new Set(tools.map((t) => t.name));

    for (const call of toolCalls) {
      if (!knownNames.has(call.name)) {
        throw new LLMError(
          `Model requested tool "${call.name}", which was not in the tools offered ([${[...knownNames].join(', ')}]).`,
          'api',
        );
      }

      const definition = tools.find((t) => t.name === call.name);

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

    if (tools && (jsonSchema || params.schema)) {
      throw new LLMError(
        '`tools` cannot be combined with `jsonSchema`/`schema`: on Anthropic and Bedrock, ' +
          'jsonSchema is implemented internally as a forced single-tool call, which would ' +
          'collide with real tools. Use one or the other.',
        'validation',
      );
    }

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
        '`toolChoice` was set without `tools` — there is nothing for it to choose between. ' +
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
   * When `call.tools` is set, this caches the *whole*
   * `CallWithToolsResult`, including `tool_calls` results, not just final
   * answers. Whether that's appropriate depends on the tool: caching "the
   * model decided to call get_weather" is usually fine to reuse briefly;
   * caching a decision made under permissions or account state that can
   * change between calls is not (see the tool-calling design doc's caching
   * guidance). If that distinction matters for your tools, use a short
   * `ttl` or route `tool_calls` results through a separate `cacheKey`/`ttl`
   * than final answers, rather than relying on this method to guess.
   *
   * @param params - `cachedCall` params (`cacheKey`, `ttl`, etc, minus `fn`)
   * plus `call`, the `CallParams` (optionally with `tools`) to pass through
   * to `this.call(...)`.
   * @returns The cached value on a hit, or the freshly-called result on a miss.
   */
  async cachedLLMCall<T>(params: CachedLLMToolCallParams<T>): Promise<CallWithToolsResult<T>>;

  async cachedLLMCall<T>(params: CachedLLMCallParams<T>): Promise<T>;

  async cachedLLMCall<T>(
    params: CachedLLMCallParams<T> | CachedLLMToolCallParams<T>,
  ): Promise<T | CallWithToolsResult<T>> {
    const { call: callParams, ...cacheParams } = params;

    const { reserveUsage, refundUsage, ...restCallParams } = callParams;

    if (reserveUsage || refundUsage) {
      this.logger.warn(
        '[VernLLM] reserveUsage/refundUsage on `call` are ignored by cachedLLMCall; set them at the top level instead.',
      );
    }

    return this.cachedCall({
      ...cacheParams,
      fn: () => this.call(restCallParams),
    });
  }

  /**
   * @returns The current circuit breaker state (`'closed' | 'open' |
   * 'half-open'`), or undefined if no circuit breaker was configured.
   */
  getCircuitState() {
    return this.breaker?.getState();
  }
}
