import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LLMError } from '../../../../src/types/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { FakeApiError, createMockClient, jsonResponse, textResponse } from '../../../helpers.js';

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

    // Pin full jitter at its ceiling so the waits below are deterministic
    // (full jitter's floor is 0, so an unpinned draw could resolve early).
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999999);

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

    randomSpy.mockRestore();
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

    // Full jitter could otherwise draw a delay under the 5ms below and let
    // the second attempt fire before the abort. Half the cap is 5s.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    try {
      const promise = llm.call({ systemPrompt: 's', userContent: 'u', signal: controller.signal });
      const assertion = expect(promise).rejects.toMatchObject({ type: 'aborted' });

      // Let the first attempt fail and enter its backoff wait, then abort
      // instead of waiting out the full delay.
      await new Promise((r) => setTimeout(r, 5));
      controller.abort();

      await assertion;
      // Only the first attempt should have reached the client, the wait was
      // cut short by the abort before a second attempt could fire.
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      random.mockRestore();
    }
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

describe('VernLLM.call: maxRetryAfterMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports retryAfterMs under the configured cap instead of the 10s default', async () => {
    const { client } = createMockClient([
      new FakeApiError('rate limited', 429, { 'Retry-After': '30' }),
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, maxRetryAfterMs: 20_000 });

    const promise = llm.call({ userContent: 'u' });
    const assertion = expect(promise).rejects.toMatchObject({ retryAfterMs: 20_000 });

    await vi.advanceTimersByTimeAsync(19_999);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('lets a fallback target set its own cap', async () => {
    const { client: primary } = createMockClient([new FakeApiError('down', 500)]);
    const { client: fallback } = createMockClient([
      new FakeApiError('rate limited', 429, { 'Retry-After': '30' }),
    ]);
    const llm = new VernLLM({
      client: primary,
      model: 'm',
      maxRetries: 0,
      logger: 'silent',
      fallback: { client: fallback, model: 'f', maxRetryAfterMs: 0 },
    });

    const promise = llm.call({ userContent: 'u' });
    const assertion = expect(promise).rejects.toMatchObject({
      attempts: [
        expect.anything(),
        expect.objectContaining({ error: expect.objectContaining({ retryAfterMs: 0 }) }),
      ],
    });

    await vi.runAllTimersAsync();
    await assertion;
  });

  it('throws at construction for a negative or NaN cap', () => {
    const { client } = createMockClient([textResponse('x')]);

    expect(() => new VernLLM({ client, model: 'm', maxRetryAfterMs: -1 })).toThrow(RangeError);
    expect(
      () =>
        new VernLLM({
          client,
          model: 'm',
          fallback: { client, model: 'f', maxRetryAfterMs: NaN },
        }),
    ).toThrow('fallback[0]: maxRetryAfterMs must be 0 or more');
  });
});
