import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LLMError } from '../../../../src/types/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { createMockClient, jsonResponse } from '../../../helpers.js';

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

  it('logs, instead of throwing, when refundUsage itself throws after a call failure', async () => {
    const reserveUsage = vi.fn();
    const refundError = new Error('refund boom');
    const refundUsage = vi.fn(async () => {
      throw refundError;
    });
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { client } = createMockClient([new Error('boom')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0, logger });

    await expect(
      llm.call({ systemPrompt: 's', userContent: 'u', reserveUsage, refundUsage }),
    ).rejects.toMatchObject({ type: 'unknown' }); // original error still propagates
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] refundUsage failed', {
      message: 'refund boom',
      stack: refundError.stack,
    });
  });

  it('falls back to an undefined stack when refundUsage throws a non-Error value', async () => {
    const reserveUsage = vi.fn();
    const refundUsage = vi.fn(async () => {
      throw 'not an Error instance';
    });
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { client } = createMockClient([new Error('boom')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0, logger });

    await expect(
      llm.call({ systemPrompt: 's', userContent: 'u', reserveUsage, refundUsage }),
    ).rejects.toMatchObject({ type: 'unknown' });
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] refundUsage failed', {
      message: 'unknown',
      stack: undefined,
    });
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
