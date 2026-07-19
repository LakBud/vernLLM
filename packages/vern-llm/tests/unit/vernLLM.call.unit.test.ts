import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { LLMError } from '../../src/types.js';
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

describe('VernLLM.call — retry & backoff', () => {
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
});

describe('VernLLM.call — abort during backoff wait', () => {
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
    // Only the first attempt should have reached the client — the wait was
    // cut short by the abort before a second attempt could fire.
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('VernLLM.call — non-retryable status codes', () => {
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

describe('VernLLM.call — parse failures', () => {
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

describe('VernLLM.call — abort handling', () => {
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

describe('LLMError', () => {
  it('carries type, status, and issues', () => {
    const err = new LLMError('boom', 'validation', undefined, { field: 'name' });
    expect(err.type).toBe('validation');
    expect(err.issues).toEqual({ field: 'name' });
    expect(err).toBeInstanceOf(Error);
  });
});
