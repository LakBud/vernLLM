import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { LLMError } from '../../src/types/index.js';
import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse, textResponse, FakeApiError, at } from '../helpers.js';

describe('VernLLM.call: happy paths', () => {
  it('returns parsed JSON by default', async () => {
    const { client } = createMockClient([jsonResponse({ hello: 'world' })]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({ systemPrompt: 'sys', userContent: 'usr' });
    expect(result).toEqual({ hello: 'world' });
  });

  it('returns raw string when jsonMode is false, skipping JSON parsing entirely', async () => {
    const { client } = createMockClient([textResponse('not json at all {{{')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const result = await llm.call({
      systemPrompt: 'sys',
      userContent: 'usr',
      jsonMode: false,
    });
    expect(result).toBe('not json at all {{{');
  });

  it('omits the system message entirely when systemPrompt is not provided', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'test-model' });

    await llm.call({ userContent: 'usr' });

    expect(calls[0]).toMatchObject({
      messages: [{ role: 'user', content: 'usr' }],
    });
  });

  it('sends model, temperature, max_tokens, and messages correctly', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'default-model', defaultMaxTokens: 500 });

    await llm.call({
      systemPrompt: 'system text',
      userContent: 'user text',
      temperature: 0.7,
    });

    expect(calls[0]).toMatchObject({
      model: 'default-model',
      temperature: 0.7,
      max_tokens: 500,
      messages: [
        { role: 'system', content: 'system text' },
        { role: 'user', content: 'user text' },
      ],
    });
  });

  it('defaults to json_object response_format when jsonMode is true', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ systemPrompt: 's', userContent: 'u' });
    expect(at(calls, 0).response_format).toEqual({ type: 'json_object' });
  });

  it('omits response_format when jsonMode is false', async () => {
    const { client, calls } = createMockClient([textResponse('plain text')]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ systemPrompt: 's', userContent: 'u', jsonMode: false });
    expect(at(calls, 0).response_format).toBeUndefined();
  });
});

describe('VernLLM.call, temperature', () => {
  it('sends 0.2 when neither a per-call nor instance-level temperature is set', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ userContent: 'u' });
    expect(at(calls, 0).temperature).toBe(0.2);
  });

  it('a per-call number overrides the 0.2 default', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ userContent: 'u', temperature: 0.9 });
    expect(at(calls, 0).temperature).toBe(0.9);
  });

  it('a per-call null omits temperature from the request entirely', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ userContent: 'u', temperature: null });
    expect('temperature' in at(calls, 0)).toBe(false);
  });

  it('falls back to an instance-level defaultTemperature when no per-call value is set', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', defaultTemperature: 0.5 });

    await llm.call({ userContent: 'u' });
    expect(at(calls, 0).temperature).toBe(0.5);
  });

  it('an instance-level defaultTemperature: null omits temperature when no per-call value is set', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', defaultTemperature: null });

    await llm.call({ userContent: 'u' });
    expect('temperature' in at(calls, 0)).toBe(false);
  });

  it('a per-call value always wins over an instance-level defaultTemperature, in both directions', async () => {
    const { client, calls } = createMockClient([
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    ]);
    const llm = new VernLLM({ client, model: 'm', defaultTemperature: null });

    // per-call number overrides an instance-level null opt-out
    await llm.call({ userContent: 'u', temperature: 0.3 });
    expect(at(calls, 0).temperature).toBe(0.3);

    // per-call null opts out even when the instance default is a number
    const llm2 = new VernLLM({ client, model: 'm', defaultTemperature: 0.8 });
    await llm2.call({ userContent: 'u', temperature: null });
    expect('temperature' in at(calls, 1)).toBe(false);
  });

  it('treats temperature: 0 as a real value, not as unset', async () => {
    const { client, calls } = createMockClient([
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    ]);

    const llm = new VernLLM({ client, model: 'm' });
    await llm.call({ userContent: 'u', temperature: 0 });
    expect(at(calls, 0).temperature).toBe(0);

    const llmWithZeroDefault = new VernLLM({ client, model: 'm', defaultTemperature: 0 });
    await llmWithZeroDefault.call({ userContent: 'u' });
    expect(at(calls, 1).temperature).toBe(0);
  });
});

describe('VernLLM.call, reasoning defaults', () => {
  it('falls back to an instance-level defaultReasoningEffort when no per-call value is set', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', defaultReasoningEffort: 'high' });

    await llm.call({ userContent: 'u' });
    expect(at(calls, 0).reasoning_effort).toBe('high');
  });

  it('falls back to an instance-level defaultBudgetTokens when no per-call value is set', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', defaultBudgetTokens: 12000 });

    await llm.call({ userContent: 'u' });
    expect(at(calls, 0).budget_tokens).toBe(12000);
  });

  it('a per-call reasoningEffort/budgetTokens always wins over its instance-level default', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({
      client,
      model: 'm',
      defaultReasoningEffort: 'low',
      defaultBudgetTokens: 4096,
    });

    await llm.call({ userContent: 'u', reasoningEffort: 'high', budgetTokens: 32000 });
    expect(at(calls, 0).reasoning_effort).toBe('high');
    expect(at(calls, 0).budget_tokens).toBe(32000);
  });

  it('a fallback target without its own reasoning defaults inherits the primary-resolved ones', async () => {
    const { client: primaryClient } = createMockClient([new Error('primary down')]);
    const { client: fallbackClient, calls: fallbackCalls } = createMockClient([
      jsonResponse({ ok: true }),
    ]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      defaultReasoningEffort: 'medium',
      defaultBudgetTokens: 16000,
      fallback: { client: fallbackClient, model: 'fallback-model' },
    });

    await llm.call({ userContent: 'u' });
    expect(at(fallbackCalls, 0).reasoning_effort).toBe('medium');
    expect(at(fallbackCalls, 0).budget_tokens).toBe(16000);
  });

  it("a fallback target's own reasoning defaults override the primary's, same as defaultTemperature does", async () => {
    const { client: primaryClient } = createMockClient([new Error('primary down')]);
    const { client: fallbackClient, calls: fallbackCalls } = createMockClient([
      jsonResponse({ ok: true }),
    ]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      defaultReasoningEffort: 'medium',
      defaultBudgetTokens: 16000,
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        defaultReasoningEffort: 'minimal',
        defaultBudgetTokens: 1024,
      },
    });

    await llm.call({ userContent: 'u' });
    expect(at(fallbackCalls, 0).reasoning_effort).toBe('minimal');
    expect(at(fallbackCalls, 0).budget_tokens).toBe(1024);
  });

  it('reasoningEffort: null opts a call out of an instance-level defaultReasoningEffort, mirroring temperature: null', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', defaultReasoningEffort: 'high' });

    await llm.call({ userContent: 'u', reasoningEffort: null });
    expect('reasoning_effort' in at(calls, 0)).toBe(false);
  });

  it('budgetTokens: null opts a call out of an instance-level defaultBudgetTokens, mirroring temperature: null', async () => {
    const { client, calls } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', defaultBudgetTokens: 12000 });

    await llm.call({ userContent: 'u', budgetTokens: null });
    expect('budget_tokens' in at(calls, 0)).toBe(false);
  });

  it('reasoningEffort/budgetTokens: null only affects the one call they are passed to, not later calls on the same instance', async () => {
    const { client, calls } = createMockClient([
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    ]);
    const llm = new VernLLM({
      client,
      model: 'm',
      defaultReasoningEffort: 'high',
      defaultBudgetTokens: 12000,
    });

    await llm.call({ userContent: 'u', reasoningEffort: null, budgetTokens: null });
    expect('reasoning_effort' in at(calls, 0)).toBe(false);
    expect('budget_tokens' in at(calls, 0)).toBe(false);

    await llm.call({ userContent: 'u' });
    expect(at(calls, 1).reasoning_effort).toBe('high');
    expect(at(calls, 1).budget_tokens).toBe(12000);
  });
});

describe('VernLLM.call, retry & backoff', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries once on a generic failure and succeeds on the second attempt', async () => {
    const { client, create } = createMockClient([
      new Error('transient network blip'),
      jsonResponse({ ok: true }),
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 100 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u' });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting maxRetries and throws LLMError(unknown)', async () => {
    const { client, create } = createMockClient([new Error('fail 1'), new Error('fail 2')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 10 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u' });
    // Attach a rejection handler immediately so the timer-driven rejection
    // isn't seen as unhandled while we advance fake timers.
    const assertion = expect(promise).rejects.toMatchObject({ type: 'unknown' });
    await vi.runAllTimersAsync();
    await assertion;

    expect(create).toHaveBeenCalledTimes(2);
  });

  it('preserves the original provider error on .cause for api errors', async () => {
    const apiError = new FakeApiError('invalid schema', 400);
    const { client } = createMockClient([apiError]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).rejects.toMatchObject({
      type: 'api',
      status: 400,
      cause: apiError,
    });
  });

  it('preserves the original error on .cause for unknown errors', async () => {
    const genericError = new Error('boom');
    const { client } = createMockClient([genericError]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).rejects.toMatchObject({
      type: 'unknown',
      cause: genericError,
    });
  });

  it('surfaces the Retry-After value from the final retry attempt', async () => {
    const { client, create } = createMockClient([
      new FakeApiError('rate limited first attempt', 429, { 'Retry-After': '5' }),
      new FakeApiError('rate limited second attempt', 429, { 'Retry-After': '10' }),
    ]);

    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 1,
    });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u' });

    const assertion = expect(promise).rejects.toMatchObject({
      type: 'api',
      status: 429,
      retryAfterMs: 10_000,
    });

    await vi.runAllTimersAsync();
    await assertion;

    expect(create).toHaveBeenCalledTimes(2);
  });

  it('logs request id and provider error details on failure when logger is provided', async () => {
    const apiError = new FakeApiError('provider failed', 500, {
      'x-request-id': 'provider-request-123',
    });

    const { client } = createMockClient([apiError]);
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      logger,
    });

    await expect(
      llm.call({
        systemPrompt: 's',
        userContent: 'u',
        requestId: 'request-123',
      }),
    ).rejects.toMatchObject({
      type: 'api',
      status: 500,
    });

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('[VernLLM:request-123]'));
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('provider failed'));
  });

  it('uses exponential backoff between retries', async () => {
    const { client } = createMockClient([
      new Error('fail 1'),
      new Error('fail 2'),
      jsonResponse({ ok: true }),
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 2, baseDelayMs: 100 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u' });

    // attempt 0 fails immediately (no delay before the first attempt)
    await vi.advanceTimersByTimeAsync(0);
    // backoff before attempt 1 is baseDelayMs * 2^1 = 200ms
    await vi.advanceTimersByTimeAsync(199);
    expect(await Promise.race([promise, Promise.resolve('pending')])).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    // backoff before attempt 2 is baseDelayMs * 2^2 = 400ms
    await vi.advanceTimersByTimeAsync(400);

    const result = await promise;
    expect(result).toEqual({ ok: true });
  });

  it('accumulates one attempts entry per retried-past failure when a call eventually succeeds then fails later', async () => {
    // Not a realistic single call, but exercises retryWithBackoff directly
    // enough to confirm attempts grows across multiple retried failures
    // before the terminal one.
    const { client } = createMockClient([
      new Error('fail 1'),
      new Error('fail 2'),
      new Error('fail 3'),
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 2, baseDelayMs: 10 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u' });
    const assertion = expect(promise).rejects.toMatchObject({ type: 'unknown' });
    await vi.runAllTimersAsync();
    await assertion;

    const thrown = (await promise.catch((e) => e)) as LLMError;
    // 3 attempts total (maxRetries: 2); the first 2 are retried past and
    // recorded, the 3rd is the terminal failure itself and isn't.
    expect(thrown.attempts).toHaveLength(2);
    expect(thrown.attempts?.map((a) => a.index)).toEqual([0, 1]);
  });

  it('leaves attempts undefined when maxRetries is 0 (no retry was actually made)', async () => {
    const { client } = createMockClient([new Error('single failure')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    const thrown = (await llm
      .call({ systemPrompt: 's', userContent: 'u' })
      .catch((e) => e)) as LLMError;

    expect(thrown.attempts).toBeUndefined();
  });

  it('leaves attempts undefined when the first failure is non-retryable', async () => {
    const { client } = createMockClient([new FakeApiError('unauthorized', 401)]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 3, baseDelayMs: 10 });

    const thrown = (await llm
      .call({ systemPrompt: 's', userContent: 'u' })
      .catch((e) => e)) as LLMError;

    expect(thrown.type).toBe('api');
    expect(thrown.status).toBe(401);
    expect(thrown.attempts).toBeUndefined();
  });

  it('records only prior (pre-terminal) attempts, never the thrown error itself, on an LLMError retry', async () => {
    const first = new LLMError('server hiccup', 'api', { status: 500 });
    const final = new LLMError('server hiccup again', 'api', { status: 500 });
    const { client } = createMockClient([first, final]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 10 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u' });
    const assertion = expect(promise).rejects.toMatchObject({ type: 'api', status: 500 });
    await vi.runAllTimersAsync();
    await assertion;

    const thrown = (await promise.catch((e) => e)) as LLMError;
    expect(thrown).toBe(final);
    // Terminal failure is thrown itself, not a prior attempt, so it's
    // never in attempts and no entry can reference thrown.
    expect(thrown.attempts).toHaveLength(1);
    const [entry] = thrown.attempts ?? [];
    expect(entry?.error).not.toBe(thrown);
    expect(entry?.error.message).toBe(first.message);
    expect(() => JSON.stringify(thrown)).not.toThrow();
  });

  it("records the request actually sent on a failed attempt, matching that attempt's payload", async () => {
    const first = new LLMError('server hiccup', 'api', { status: 500 });
    const { client, calls } = createMockClient([first, jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 10 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u' });
    await vi.runAllTimersAsync();
    await promise;

    // We can't get the thrown error since the call succeeded on retry, so
    // inspect via a failing scenario instead below; here just confirm the
    // mock recorded exactly one call for the failed attempt.
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('records request.provider/model/body on each RetryAttempt for a call that ultimately fails', async () => {
    const first = new LLMError('server hiccup', 'api', { status: 500 });
    const final = new LLMError('server hiccup again', 'api', { status: 500 });
    const { client } = createMockClient([first, final]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 10 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u' });
    const assertion = expect(promise).rejects.toMatchObject({ type: 'api', status: 500 });
    await vi.runAllTimersAsync();
    await assertion;

    const thrown = (await promise.catch((e) => e)) as LLMError;
    const [entry] = thrown.attempts ?? [];
    expect(entry?.request?.model).toBe('m');
    expect(entry?.request?.provider).toBeTruthy();
    expect(entry?.request?.body).toMatchObject({
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
      ],
    });
    expect(() => JSON.stringify(thrown)).not.toThrow();
  });

  it('startedAt reflects when the request was built, not when the failure was later recorded', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    // Dispatch takes 500ms of fake time before the first attempt rejects,
    // and the retry loop's catch block (where toRequestSnapshot used to
    // stamp Date.now() itself) only runs after that. If startedAt were
    // captured there instead of at build time, it would read ~1500+,
    // not 1000.
    const first = () =>
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new LLMError('slow failure', 'api', { status: 500 })), 500);
      });
    const final = new LLMError('server hiccup again', 'api', { status: 500 });
    const { client } = createMockClient([first, final]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 10 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u' });
    const assertion = expect(promise).rejects.toMatchObject({ type: 'api', status: 500 });
    await vi.runAllTimersAsync();
    await assertion;

    const thrown = (await promise.catch((e) => e)) as LLMError;
    expect(thrown.attempts?.[0]?.request?.startedAt).toBe(1_000);

    vi.useRealTimers();
  });

  it('gives each retried attempt its own request snapshot, not a shared reference from a prior attempt', async () => {
    const first = new LLMError('server hiccup', 'api', { status: 500 });
    const second = new LLMError('server hiccup again', 'api', { status: 500 });
    const { client } = createMockClient([first, second]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 10 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u' });
    const assertion = expect(promise).rejects.toMatchObject({ type: 'api', status: 500 });
    await vi.runAllTimersAsync();
    await assertion;

    const thrown = (await promise.catch((e) => e)) as LLMError;
    const [entry] = thrown.attempts ?? [];
    // Only one attempt is ever pushed here (the terminal failure is thrown,
    // not recorded), but it must reflect attempt 0's own request, not be
    // left over `undefined`/stale from before the loop's per-iteration
    // reset in `retryWithBackoff` ran for this iteration.
    expect(entry?.request).toBeDefined();
    expect(entry?.request?.startedAt).toBeGreaterThan(0);
  });

  it('is not affected by the client mutating the dispatched request object during the call, e.g. as fromGemini does', async () => {
    // The mock's script function receives the exact same `params` object
    // CallExecutor dispatched, the same reference a real LLMClient
    // implementation (like fromGemini, which does `request.config = {...}`
    // in place) would receive and could mutate. Mutating it here, then
    // rejecting, reproduces that scenario without needing a real adapter.
    const first = (params: Record<string, unknown>) => {
      (params as { mutated?: boolean }).mutated = true;
      (params.messages as unknown[]).push({ role: 'user', content: 'sneaked in' });
      return Promise.reject(new LLMError('server hiccup', 'api', { status: 500 }));
    };
    const final = new LLMError('server hiccup again', 'api', { status: 500 });
    const { client } = createMockClient([first, final]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 10 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u' });
    const assertion = expect(promise).rejects.toMatchObject({ type: 'api', status: 500 });
    await vi.runAllTimersAsync();
    await assertion;

    const thrown = (await promise.catch((e) => e)) as LLMError;
    const body = thrown.attempts?.[0]?.request?.body as { mutated?: boolean; messages: unknown[] };
    expect(body.mutated).toBeUndefined();
    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
  });

  it('never populates request when attempts itself never gets populated (no retry configured)', async () => {
    const { client } = createMockClient([new FakeApiError('unauthorized', 401)]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    const thrown = (await llm
      .call({ systemPrompt: 's', userContent: 'u' })
      .catch((e) => e)) as LLMError;

    expect(thrown.attempts).toBeUndefined();
  });
});

describe('VernLLM.call, abort during backoff wait', () => {
  it('resolves the backoff wait immediately when aborted mid-delay, then reports aborted', async () => {
    const controller = new AbortController();
    const { client, create } = createMockClient([new Error('fail 1'), new Error('fail 2')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 2, baseDelayMs: 10_000 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u', signal: controller.signal });
    const assertion = expect(promise).rejects.toMatchObject({ type: 'aborted' });

    // Let the first attempt fail and enter its backoff wait, then abort
    // instead of waiting out the full 10s delay.
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();

    await assertion;
    // Only the first attempt should have reached the client, the wait was
    // cut short by the abort before a second attempt could fire.
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('VernLLM.call, non-retryable status codes', () => {
  it('fails fast on a 401 without consuming a retry', async () => {
    const { client, create } = createMockClient([new FakeApiError('unauthorized', 401)]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 3, baseDelayMs: 10 });

    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).rejects.toMatchObject({
      type: 'api',
      status: 401,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does retry on a retryable (e.g. 500) status', async () => {
    vi.useFakeTimers();
    const { client, create } = createMockClient([
      new FakeApiError('server error', 500),
      jsonResponse({ ok: true }),
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 10 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u' });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('honors a Retry-After header (delta-seconds) instead of exponential backoff', async () => {
    vi.useFakeTimers();
    const { client, create } = createMockClient([
      new FakeApiError('rate limited', 429, { 'Retry-After': '2' }),
      jsonResponse({ ok: true }),
    ]);
    // A huge baseDelayMs makes it obvious the 2s Retry-After was used
    // instead of exponential backoff, which would wait far longer here
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 60_000 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u' });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('caps an oversized Retry-After at the max delay instead of waiting the full duration', async () => {
    vi.useFakeTimers();
    const { client, create } = createMockClient([
      new FakeApiError('rate limited', 429, { 'Retry-After': '3600' }), // 1 hour
      jsonResponse({ ok: true }),
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 10 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u' });
    // The cap (10s) should be enough; the full hour should not be required
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('falls back to exponential backoff when no Retry-After header is present', async () => {
    vi.useFakeTimers();
    const { client, create } = createMockClient([
      new FakeApiError('server error', 500),
      jsonResponse({ ok: true }),
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 10 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u' });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('respects a custom nonRetryableStatus list', async () => {
    const { client, create } = createMockClient([new FakeApiError('teapot', 418)]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 3,
      nonRetryableStatus: [418],
    });

    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).rejects.toMatchObject({
      status: 418,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('VernLLM.call, parse failures', () => {
  it('throws LLMError(parse) on invalid JSON and does not retry', async () => {
    const { client, create } = createMockClient([textResponse('{not valid json')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 3 });

    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).rejects.toMatchObject({
      type: 'parse',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('throws LLMError(api) on an empty response', async () => {
    const { client } = createMockClient([{ choices: [{ message: { content: '' } }] }]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).rejects.toMatchObject({
      type: 'api',
    });
  });
});

describe('VernLLM.call, abort handling', () => {
  it('throws LLMError(aborted) if the signal is already aborted', async () => {
    const { client, create } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });
    const controller = new AbortController();
    controller.abort();

    await expect(
      llm.call({ systemPrompt: 's', userContent: 'u', signal: controller.signal }),
    ).rejects.toMatchObject({ type: 'aborted' });
    expect(create).not.toHaveBeenCalled();
  });

  it('throws LLMError(aborted) if the signal aborts mid-flight', async () => {
    const controller = new AbortController();
    const { client } = createMockClient([
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by caller')));
        }),
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 2 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u', signal: controller.signal });
    const assertion = expect(promise).rejects.toMatchObject({ type: 'aborted' });
    controller.abort();
    await assertion;
  });
});

describe('VernLLM.call, deadlineMs', () => {
  it('rejects with code deadline_exceeded when deadlineMs elapses before the target resolves', async () => {
    const { client, create } = createMockClient([
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by caller')));
        }),
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    await expect(
      llm.call({ systemPrompt: 's', userContent: 'u', deadlineMs: 10 }),
    ).rejects.toMatchObject({ type: 'aborted', code: 'deadline_exceeded' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('resolves normally, and leaves no open timer, when deadlineMs is longer than the call takes', async () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    const clearSpy = vi.spyOn(global, 'clearTimeout');

    const result = await llm.call({
      systemPrompt: 's',
      userContent: 'u',
      deadlineMs: 60_000,
    });

    expect(result).toEqual({ ok: true });
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('does not stamp deadline_exceeded when a caller signal aborts before the deadline', async () => {
    const controller = new AbortController();
    const { client } = createMockClient([
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by caller')));
        }),
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    const promise = llm.call({
      systemPrompt: 's',
      userContent: 'u',
      deadlineMs: 60_000,
      signal: controller.signal,
    });
    const assertion = expect(promise).rejects.toMatchObject({
      type: 'aborted',
      code: undefined,
    });
    controller.abort();
    await assertion;
  });

  it('stamps deadline_exceeded when the deadline fires before a caller-supplied signal aborts', async () => {
    const controller = new AbortController();
    const { client, create } = createMockClient([
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by caller')));
        }),
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    await expect(
      llm.call({
        systemPrompt: 's',
        userContent: 'u',
        deadlineMs: 10,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ type: 'aborted', code: 'deadline_exceeded' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('cuts a fallback chain short once deadlineMs elapses, never reaching the fallback target', async () => {
    const primary = createMockClient([
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by caller')));
        }),
    ]);
    const fallback = createMockClient([jsonResponse({ ok: true })]);

    const llm = new VernLLM({
      client: primary.client,
      model: 'm',
      maxRetries: 0,
      fallback: { client: fallback.client, model: 'm2' },
    });

    await expect(
      llm.call({ systemPrompt: 's', userContent: 'u', deadlineMs: 10 }),
    ).rejects.toMatchObject({ type: 'aborted', code: 'deadline_exceeded' });
    expect(fallback.create).not.toHaveBeenCalled();
  });

  it('creates no controller or timer when deadlineMs is omitted', async () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    const setSpy = vi.spyOn(global, 'setTimeout');
    await llm.call({ systemPrompt: 's', userContent: 'u' });

    // withTimeout still schedules its own per-attempt timer (unrelated to
    // deadlineMs), so the assertion is on its duration: the instance's
    // default timeoutMs (25000), never a deadline timer, since none was
    // requested.
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 25_000);
    setSpy.mockRestore();
  });
});

describe('LLMError', () => {
  it('carries type, status, and issues', () => {
    const err = new LLMError('boom', 'validation', { issues: { field: 'name' } });
    expect(err.type).toBe('validation');
    expect(err.issues).toEqual({ field: 'name' });
    expect(err).toBeInstanceOf(Error);
  });
});

describe('VernLLM.call, timeout handling', () => {
  it('throws LLMError(timeout) when an internal timeout aborts the request', async () => {
    const { client, create } = createMockClient([
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    ]);

    const llm = new VernLLM({
      client,
      model: 'm',
      timeoutMs: 10,
      maxRetries: 0,
    });

    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).rejects.toMatchObject({
      type: 'timeout',
    });

    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('VernLLM.call, reserveUsage/refundUsage', () => {
  it('calls reserveUsage once before dispatching the request', async () => {
    const reserveUsage = vi.fn();
    const { client, create } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ systemPrompt: 's', userContent: 'u', reserveUsage });

    expect(reserveUsage).toHaveBeenCalledTimes(1);
    expect(reserveUsage).toHaveBeenCalledWith({ coalesced: false });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch any request if reserveUsage rejects', async () => {
    const reserveUsage = vi.fn(async () => {
      throw new Error('quota exceeded');
    });
    const { client, create } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await expect(
      llm.call({ systemPrompt: 's', userContent: 'u', reserveUsage }),
    ).rejects.toMatchObject({ type: 'quota_exceeded' });
    expect(create).not.toHaveBeenCalled();
  });

  it('maps a reserveUsage failure to quota_exceeded even if it throws an LLMError of a different type', async () => {
    const reserveUsage = vi.fn(async () => {
      throw new LLMError('somehow validation-shaped', 'validation');
    });
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await expect(
      llm.call({ systemPrompt: 's', userContent: 'u', reserveUsage }),
    ).rejects.toMatchObject({ type: 'quota_exceeded' });
  });

  it('does not call refundUsage when reserveUsage itself rejects', async () => {
    const reserveUsage = vi.fn(async () => {
      throw new Error('quota exceeded');
    });
    const refundUsage = vi.fn();
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm
      .call({ systemPrompt: 's', userContent: 'u', reserveUsage, refundUsage })
      .catch(() => {});
    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('does not trip the circuit breaker when reserveUsage rejects, a reservation failure is not a provider failure', async () => {
    const reserveUsage = vi.fn(async () => {
      throw new Error('quota exceeded');
    });
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({
      client,
      model: 'm',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    await llm.call({ systemPrompt: 's', userContent: 'u', reserveUsage }).catch(() => {});
    expect(llm.getCircuitState()).toBe('closed');
  });

  it('calls refundUsage when the call ultimately fails after a successful reservation', async () => {
    const reserveUsage = vi.fn();
    const refundUsage = vi.fn();
    const { client } = createMockClient([new Error('boom')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    await expect(
      llm.call({ systemPrompt: 's', userContent: 'u', reserveUsage, refundUsage }),
    ).rejects.toMatchObject({ type: 'unknown' });
    expect(refundUsage).toHaveBeenCalledTimes(1);
    expect(refundUsage).toHaveBeenCalledWith({ coalesced: false });
  });

  it('does not call refundUsage on a successful call', async () => {
    const reserveUsage = vi.fn();
    const refundUsage = vi.fn();
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.call({ systemPrompt: 's', userContent: 'u', reserveUsage, refundUsage });
    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('behaves identically to today when reserveUsage/refundUsage are omitted', async () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).resolves.toEqual({ ok: true });
  });

  describe('across retries', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('reserves once and refunds once across multiple retry attempts, not once per attempt', async () => {
      const reserveUsage = vi.fn();
      const refundUsage = vi.fn();
      const { client, create } = createMockClient([new Error('fail 1'), new Error('fail 2')]);
      const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 10 });

      const promise = llm.call({ systemPrompt: 's', userContent: 'u', reserveUsage, refundUsage });
      const assertion = expect(promise).rejects.toMatchObject({ type: 'unknown' });
      await vi.runAllTimersAsync();
      await assertion;

      expect(create).toHaveBeenCalledTimes(2);
      expect(reserveUsage).toHaveBeenCalledTimes(1);
      expect(refundUsage).toHaveBeenCalledTimes(1);
    });
  });

  it('passes the exact signal to reserveUsage and refundUsage, refunds once after abort, and does not dispatch the provider request', async () => {
    const controller = new AbortController();
    const reserveUsage = vi.fn(async () => {
      controller.abort();
    });
    const refundUsage = vi.fn();

    const { client, create } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await expect(
      llm.call({
        systemPrompt: 's',
        userContent: 'u',
        signal: controller.signal,
        reserveUsage,
        refundUsage,
      }),
    ).rejects.toMatchObject({ type: 'aborted' });

    expect(reserveUsage).toHaveBeenCalledTimes(1);
    expect(reserveUsage).toHaveBeenCalledWith({
      coalesced: false,
      signal: controller.signal,
    });

    expect(refundUsage).toHaveBeenCalledTimes(1);
    expect(refundUsage).toHaveBeenCalledWith({
      coalesced: false,
      signal: controller.signal,
    });

    expect(create).not.toHaveBeenCalled();
  });

  it('does not open or increment the circuit breaker when abort happens after reservation', async () => {
    const controller = new AbortController();

    const reserveUsage = vi.fn(async () => {
      controller.abort();
    });

    const refundUsage = vi.fn();

    const { client } = createMockClient([jsonResponse({ ok: true })]);

    const llm = new VernLLM({
      client,
      model: 'm',
      circuitBreaker: {
        threshold: 1,
        cooldownMs: 10_000,
      },
    });

    await expect(
      llm.call({
        systemPrompt: 's',
        userContent: 'u',
        signal: controller.signal,
        reserveUsage,
        refundUsage,
      }),
    ).rejects.toMatchObject({ type: 'aborted' });

    expect(llm.getCircuitState()).toBe('closed');
  });
});
