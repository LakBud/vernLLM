import { describe, it, expect, vi } from 'vitest';

import {
  FallbackExhaustedError,
  defaultFallbackOn,
  isFallbackExhaustedError,
  isLLMError,
  LLMError,
  type VernLLMEvent,
} from '../../src/types/index.js';
import { VernLLM } from '../../src/vernLLM.js';
import {
  createMockClient,
  FakeApiError,
  jsonResponse,
  textResponse,
  toolCallResponse,
} from '../helpers.js';

describe('VernLLM, fallback', () => {
  it('primary succeeds: no fallback target is touched, meta reports usedFallback: false', async () => {
    const { client: primaryClient } = createMockClient([jsonResponse({ ok: true })]);
    const { client: fallbackClient, create: fallbackCreate } = createMockClient([
      jsonResponse({ ok: 'should never be reached' }),
    ]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      fallback: { client: fallbackClient, model: 'fallback-model' },
    });

    const meta: { current?: import('../../src/types/index.js').CallMeta } = {};
    const result = await llm.call({ userContent: 'u', meta });

    expect(result).toEqual({ ok: true });
    expect(fallbackCreate).not.toHaveBeenCalled();
    expect(meta.current).toMatchObject({
      provider: 'primary',
      model: 'primary-model',
      fallbackIndex: -1,
      usedFallback: false,
      attempts: 1,
    });
  });

  it("primary exhausts retries, target 1 receives a wire request identical to the primary's except for model", async () => {
    const { client: primaryClient, calls: primaryCalls } = createMockClient([
      new Error('primary down'),
    ]);
    const { client: fallbackClient, calls: fallbackCalls } = createMockClient([
      jsonResponse({ ok: true }),
    ]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      baseDelayMs: 0,
      fallback: { client: fallbackClient, model: 'fallback-model' },
    });

    const tools = [
      {
        name: 'getWeather',
        description: 'Gets the weather',
        parameters: { type: 'object' as const, properties: {} },
      },
    ];

    const result = await llm.call({ userContent: 'u', tools });

    expect(result).toEqual({ type: 'content', content: '{"ok":true}' });
    expect(primaryCalls).toHaveLength(1);
    expect(fallbackCalls).toHaveLength(1);
    expect(fallbackCalls[0]?.model).toBe('fallback-model');
    expect(fallbackCalls[0]?.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'getWeather',
          description: 'Gets the weather',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);

    // Same request, modulo the model each target was configured with:
    // fallback isn't rewriting or dropping anything on the way over.
    const { model: primaryModel, ...primaryRest } = primaryCalls[0]!;
    const { model: fallbackModel, ...fallbackRest } = fallbackCalls[0]!;
    expect(fallbackRest).toEqual(primaryRest);
    expect(primaryModel).toBe('primary-model');
    expect(fallbackModel).toBe('fallback-model');
  });

  it('a parse error stops the chain instead of falling over', async () => {
    const { client: primaryClient } = createMockClient([textResponse('not valid json')]);
    const { client: fallbackClient, create: fallbackCreate } = createMockClient([
      jsonResponse({ ok: true }),
    ]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      fallback: { client: fallbackClient, model: 'fallback-model' },
    });

    await expect(llm.call({ userContent: 'u' })).rejects.toMatchObject({ type: 'parse' });
    expect(fallbackCreate).not.toHaveBeenCalled();
  });

  it('a validation error (schema) stops the chain instead of falling over', async () => {
    const { z } = await import('zod');
    const { client: primaryClient } = createMockClient([jsonResponse({ wrong: 'shape' })]);
    const { client: fallbackClient, create: fallbackCreate } = createMockClient([
      jsonResponse({ ok: true }),
    ]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      fallback: { client: fallbackClient, model: 'fallback-model' },
    });

    await expect(
      llm.call({ userContent: 'u', schema: z.object({ ok: z.boolean() }) }),
    ).rejects.toMatchObject({ type: 'validation' });
    expect(fallbackCreate).not.toHaveBeenCalled();
  });

  it('a quota_exceeded error (reserveUsage failure) stops the chain instead of falling over', async () => {
    const { client: primaryClient } = createMockClient([jsonResponse({ ok: true })]);
    const { client: fallbackClient, create: fallbackCreate } = createMockClient([
      jsonResponse({ ok: true }),
    ]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      fallback: { client: fallbackClient, model: 'fallback-model' },
    });

    await expect(
      llm.call({
        userContent: 'u',
        reserveUsage: async () => {
          throw new Error('over quota');
        },
      }),
    ).rejects.toMatchObject({ type: 'quota_exceeded' });
    expect(fallbackCreate).not.toHaveBeenCalled();
  });

  it('an unknown_tool error stops the chain instead of falling over', async () => {
    const { client: primaryClient } = createMockClient([
      toolCallResponse([{ id: '1', name: 'notARealTool', arguments: {} }]),
    ]);
    const { client: fallbackClient, create: fallbackCreate } = createMockClient([
      jsonResponse({ ok: true }),
    ]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      fallback: { client: fallbackClient, model: 'fallback-model' },
    });

    const tools = [
      {
        name: 'realTool',
        description: 'd',
        parameters: { type: 'object' as const, properties: {} },
      },
    ];

    await expect(llm.call({ userContent: 'u', tools })).rejects.toMatchObject({
      code: 'unknown_tool',
    });
    expect(fallbackCreate).not.toHaveBeenCalled();
  });

  it('a rate-limited (429) primary falls over to the next target once its own retries are exhausted', async () => {
    const { client: primaryClient, create: primaryCreate } = createMockClient([
      new FakeApiError('rate limited', 429),
    ]);
    const { client: fallbackClient } = createMockClient([jsonResponse({ ok: true })]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      baseDelayMs: 0,
      fallback: { client: fallbackClient, model: 'fallback-model' },
    });

    const result = await llm.call({ userContent: 'u' });

    expect(result).toEqual({ ok: true });
    expect(primaryCreate).toHaveBeenCalledTimes(1);
  });

  it('an open circuit is abandoned without exhausting retries on that target, then falls over', async () => {
    const { client: primaryClient, create: primaryCreate } = createMockClient([
      new Error('primary down'),
    ]);
    const { client: fallbackClient } = createMockClient([jsonResponse({ ok: true })]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      baseDelayMs: 0,
      circuitBreaker: { threshold: 1 },
      fallback: { client: fallbackClient, model: 'fallback-model' },
    });

    // First call trips the primary's breaker open.
    await llm.call({ userContent: 'u' }).catch(() => {});
    expect(primaryCreate).toHaveBeenCalledTimes(1);

    // Second call: the primary's breaker is open, assertBreakerClosed
    // throws 'circuit_open' without ever touching primaryClient again,
    // and the chain falls over to the fallback target.
    const result = await llm.call({ userContent: 'u' });

    expect(result).toEqual({ ok: true });
    expect(primaryCreate).toHaveBeenCalledTimes(1);
  });

  it('every target fails: FallbackExhaustedError carries all attempts in order', async () => {
    const { client: primaryClient } = createMockClient([new Error('primary down')]);
    const { client: fallback1Client } = createMockClient([new Error('fallback 1 down')]);
    const { client: fallback2Client } = createMockClient([new Error('fallback 2 down')]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      baseDelayMs: 0,
      fallback: [
        { client: fallback1Client, model: 'fallback-1-model', name: 'fallback-1' },
        { client: fallback2Client, model: 'fallback-2-model', name: 'fallback-2' },
      ],
    });

    let caught: unknown;
    try {
      await llm.call({ userContent: 'u' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FallbackExhaustedError);
    expect(isLLMError(caught)).toBe(true);

    const exhausted = caught as FallbackExhaustedError;
    expect(exhausted.attempts).toHaveLength(3);
    expect(exhausted.attempts.map((a) => a.index)).toEqual([-1, 0, 1]);
    expect(exhausted.attempts.map((a) => a.provider)).toEqual([
      'primary',
      'fallback-1',
      'fallback-2',
    ]);
  });

  it("every target fails: FallbackExhaustedError inherits the last attempt's retryAfterMs, not just its type/status", async () => {
    const lastFailure = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { get: (name: string) => (name === 'Retry-After' ? '7' : null) },
    });
    const { client: primaryClient } = createMockClient([new Error('primary down')]);
    const { client: fallbackClient } = createMockClient([lastFailure]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      baseDelayMs: 0,
      fallback: { client: fallbackClient, model: 'fallback-model', name: 'fallback-1' },
    });

    let caught: unknown;
    try {
      await llm.call({ userContent: 'u' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FallbackExhaustedError);

    const exhausted = caught as FallbackExhaustedError;
    const last = exhausted.attempts.at(-1)!.error;

    // retryAfterMs and status still inherit from the last attempt, but
    // type is always 'fallback_exhausted' (its own identity), never
    // inherited from the last attempt's own type.
    expect(exhausted.type).toBe('fallback_exhausted');
    expect(exhausted.status).toBe(last.status);
    expect(exhausted.retryAfterMs).toBe(last.retryAfterMs);
    expect(exhausted.retryAfterMs).toBe(7_000);
  });

  it('no fallback configured throws the plain error, identical to pre-fallback behavior', async () => {
    const { client } = createMockClient([new Error('down')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0, baseDelayMs: 0 });

    let caught: unknown;
    try {
      await llm.call({ userContent: 'u' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LLMError);
    expect(caught).not.toBeInstanceOf(FallbackExhaustedError);
  });

  it('a single target exhausting its own retries carries each retry attempt on the plain LLMError', async () => {
    const { client } = createMockClient([new Error('a'), new Error('b'), new Error('c')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 2, baseDelayMs: 0 });

    let caught: unknown;
    try {
      await llm.call({ userContent: 'u' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LLMError);
    expect(caught).not.toBeInstanceOf(FallbackExhaustedError);

    const error = caught as LLMError;
    // 3 attempts total (maxRetries: 2); the terminal (3rd) failure IS
    // `error` itself, so only the 2 retried-past failures before it are
    // recorded in `attempts`.
    expect(error.attempts).toHaveLength(2);
    expect(error.attempts?.map((a) => a.index)).toEqual([0, 1]);
    expect(error.attempts?.every((a) => a.error instanceof LLMError)).toBe(true);
  });

  it("every target fails: each FallbackAttempt's own error still carries that target's own retry attempts", async () => {
    const { client: primaryClient } = createMockClient([new Error('a'), new Error('b')]);
    const { client: fallbackClient } = createMockClient([new Error('c'), new Error('d')]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 1,
      baseDelayMs: 0,
      fallback: { client: fallbackClient, model: 'fallback-model', name: 'fallback-1' },
    });

    let caught: unknown;
    try {
      await llm.call({ userContent: 'u' });
    } catch (error) {
      caught = error;
    }

    expect(isFallbackExhaustedError(caught)).toBe(true);
    const exhausted = caught as FallbackExhaustedError;

    for (const targetAttempt of exhausted.attempts) {
      // maxRetries: 1 → 2 attempts per target; the terminal one is
      // `targetAttempt.error` itself, so only 1 prior attempt is recorded.
      expect(targetAttempt.error.attempts).toHaveLength(1);
    }
  });

  it('isFallbackExhaustedError narrows a caught error and rejects a plain LLMError', () => {
    const attempts = [
      { index: -1, provider: 'primary', model: 'm', error: new LLMError('down', 'api') },
      { index: 0, provider: 'fallback-1', model: 'm2', error: new LLMError('down', 'api') },
    ];
    const exhausted = new FallbackExhaustedError(attempts);
    const plain = new LLMError('down', 'api');

    expect(isFallbackExhaustedError(exhausted)).toBe(true);
    expect(isFallbackExhaustedError(plain)).toBe(false);
    expect(isFallbackExhaustedError(new Error('not an LLMError'))).toBe(false);
  });

  it("each target's breaker is independent: tripping target 0 leaves target 1 closed", async () => {
    const { client: primaryClient } = createMockClient([
      new Error('a'),
      new Error('b'),
      new Error('c'),
    ]);
    const { client: fallbackClient } = createMockClient([jsonResponse({ ok: true })]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      baseDelayMs: 0,
      circuitBreaker: { threshold: 1 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        circuitBreaker: { threshold: 1 },
      },
    });

    for (let i = 0; i < 3; i++) {
      await llm.call({ userContent: 'u' });
    }

    const states = llm.getCircuitStates();
    expect(states).toEqual([
      expect.objectContaining({ provider: 'primary', isFallback: false, state: 'open' }),
      expect.objectContaining({ isFallback: true, state: 'closed' }),
    ]);
  });

  it('stream open failure falls over to the next target', async () => {
    const primaryError = new Error('stream open failed');
    const primaryClient = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            throw new Error('not scripted');
          }),
          createStream: vi.fn(() => {
            throw primaryError;
          }),
        },
      },
    };

    const fallbackClient = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            throw new Error('not scripted');
          }),
          createStream: vi.fn(() => ({
            [Symbol.asyncIterator](): AsyncIterator<
              import('../../src/types/index.js').WireStreamChunk
            > {
              let done = false;
              return {
                async next() {
                  if (done) return { done: true as const, value: undefined };
                  done = true;
                  return { done: false as const, value: { type: 'text-delta', delta: 'hi' } };
                },
              };
            },
          })),
        },
      },
    };

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      baseDelayMs: 0,
      fallback: { client: fallbackClient, model: 'fallback-model' },
    });

    const { finalResult } = await llm.call({ userContent: 'u', stream: true, jsonMode: false });
    const result = await finalResult;

    expect(result).toBe('hi');
    expect(fallbackClient.chat.completions.createStream).toHaveBeenCalledTimes(1);
  });

  it('cachedCall stores the fallback-produced result under the original key', async () => {
    const { client: primaryClient } = createMockClient([new Error('down')]);
    const { client: fallbackClient } = createMockClient([jsonResponse({ ok: 'from-fallback' })]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      baseDelayMs: 0,
      fallback: { client: fallbackClient, model: 'fallback-model' },
    });

    const first = await llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { userContent: 'u' },
    });

    expect(first).toEqual({ ok: 'from-fallback' });

    const second = await llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { userContent: 'u' },
    });

    expect(second).toEqual({ ok: 'from-fallback' });
  });

  it('TokenUsage.provider and usedFallback match whichever target actually answered', async () => {
    const onUsage = vi.fn();
    const { client: primaryClient } = createMockClient([new Error('down')]);
    const { client: fallbackClient } = createMockClient([
      jsonResponse({ ok: true }, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }),
    ]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      baseDelayMs: 0,
      fallback: { client: fallbackClient, model: 'fallback-model', name: 'my-fallback' },
      onUsage,
    });

    await llm.call({ userContent: 'u' });

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'my-fallback',
        usedFallback: true,
        model: 'fallback-model',
      }),
    );
  });

  describe('defaultFallbackOn', () => {
    it('returns "stop" for parse, validation, aborted, and quota_exceeded errors', () => {
      expect(defaultFallbackOn(new LLMError('m', 'parse'), { isLastTarget: false })).toBe('stop');
      expect(defaultFallbackOn(new LLMError('m', 'validation'), { isLastTarget: false })).toBe(
        'stop',
      );
      expect(defaultFallbackOn(new LLMError('m', 'aborted'), { isLastTarget: false })).toBe('stop');
      expect(defaultFallbackOn(new LLMError('m', 'quota_exceeded'), { isLastTarget: false })).toBe(
        'stop',
      );
    });

    it('returns "stop" for tool-contract error codes', () => {
      const unknownTool = new LLMError('m', 'validation', { code: 'unknown_tool' });
      const dup = new LLMError('m', 'validation', { code: 'duplicate_tool_call_id' });

      expect(defaultFallbackOn(unknownTool, { isLastTarget: false })).toBe('stop');
      expect(defaultFallbackOn(dup, { isLastTarget: false })).toBe('stop');
    });

    it('returns "next" for a generic api/timeout/unknown error', () => {
      expect(defaultFallbackOn(new LLMError('m', 'api'), { isLastTarget: false })).toBe('next');
      expect(defaultFallbackOn(new LLMError('m', 'timeout'), { isLastTarget: false })).toBe('next');
      expect(defaultFallbackOn(new LLMError('m', 'unknown'), { isLastTarget: false })).toBe('next');
    });
  });

  it('a custom fallbackOn overrides the default policy entirely', async () => {
    const { client: primaryClient } = createMockClient([textResponse('not json')]);
    const { client: fallbackClient, create: fallbackCreate } = createMockClient([
      jsonResponse({ ok: true }),
    ]);

    const fallbackOn = vi.fn(() => 'next' as const);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      fallback: { client: fallbackClient, model: 'fallback-model' },
      fallbackOn,
    });

    const result = await llm.call({ userContent: 'u' });

    expect(result).toEqual({ ok: true });
    expect(fallbackCreate).toHaveBeenCalledTimes(1);
    expect(fallbackOn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'parse' }),
      expect.objectContaining({ isLastTarget: false }),
    );
  });

  it('fires a "fallback" event when the chain moves to the next target', async () => {
    const onEvent = vi.fn();
    const { client: primaryClient } = createMockClient([new Error('primary down')]);
    const { client: fallbackClient } = createMockClient([jsonResponse({ ok: true })]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      baseDelayMs: 0,
      fallback: { client: fallbackClient, model: 'fallback-model' },
      onEvent,
    });

    await llm.call({ userContent: 'u' });

    const fallbackEvents = onEvent.mock.calls
      .map((c) => c[0] as VernLLMEvent)
      .filter((e) => e.kind === 'fallback');

    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0]).toMatchObject({
      kind: 'fallback',
      from: 'primary',
      to: 'fallback[0]',
      fromIndex: -1,
      toIndex: 0,
    });
  });
});
