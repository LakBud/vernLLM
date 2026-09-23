import { afterEach, describe, expect, it, vi } from 'vitest';

import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, jsonResponse } from '../../helpers.js';

import type { CircuitBreakerAdapter } from '../../../src/circuitBreaker.js';
import type { Logger } from '../../../src/logger.js';

function logger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
}

/** A breaker adapter that records the order its hooks run in. */
function adapter(overrides: Partial<CircuitBreakerAdapter> = {}) {
  const order: string[] = [];
  const breaker: CircuitBreakerAdapter = {
    assertClosed: () => void order.push('assertClosed'),
    recordSuccess: () => void order.push('recordSuccess'),
    recordFailure: () => void order.push('recordFailure'),
    onStateChange: () => {},
    ...overrides,
  };
  return { breaker, order };
}

describe('VernLLM awaits the breaker prepare hook before assertClosed', () => {
  afterEach(() => vi.useRealTimers());

  it('runs prepare first, then assertClosed, then dispatches', async () => {
    const { client, create } = createMockClient([jsonResponse({ ok: true })]);
    const order: string[] = [];
    const { breaker } = adapter({
      prepare: async () => void order.push('prepare'),
      assertClosed: () => void order.push('assertClosed'),
    });
    create.mockImplementation(async () => {
      order.push('dispatch');
      return jsonResponse({ ok: true });
    });

    const llm = new VernLLM({ client, model: 'm', circuitBreaker: breaker });
    await llm.call({ userContent: 'x' });

    expect(order).toEqual(['prepare', 'assertClosed', 'dispatch']);
  });

  it('assertClosed decides against what prepare just refreshed', async () => {
    const { client, create } = createMockClient([jsonResponse({ ok: true })]);
    let open = false;
    const { breaker } = adapter({
      prepare: async () => {
        open = true; // the real state, learned from the remote store
      },
      assertClosed: () => {
        if (open) throw Object.assign(new Error('open'), { name: 'LLMError' });
      },
    });

    const llm = new VernLLM({ client, model: 'm', circuitBreaker: breaker, maxRetries: 0 });

    await expect(llm.call({ userContent: 'x' })).rejects.toThrow('open');
    expect(create).not.toHaveBeenCalled();
  });

  it('a breaker without prepare is checked exactly as before', async () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const { breaker, order } = adapter();

    await new VernLLM({ client, model: 'm', circuitBreaker: breaker }).call({ userContent: 'x' });

    expect(order).toEqual(['assertClosed', 'recordSuccess']);
  });

  it('fails open when prepare rejects: warns, then the call goes through', async () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const log = logger();
    const { breaker } = adapter({
      prepare: async () => {
        throw new Error('redis down');
      },
    });

    const result = await new VernLLM({
      client,
      model: 'm',
      logger: log,
      circuitBreaker: breaker,
    }).call({ userContent: 'x' });

    expect(result).toEqual({ ok: true });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('redis down'));
  });

  it('fails open when prepare hangs past its timeout', async () => {
    vi.useFakeTimers();
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const log = logger();
    const { breaker } = adapter({ prepare: () => new Promise(() => {}), prepareTimeoutMs: 200 });

    const pending = new VernLLM({
      client,
      model: 'm',
      logger: log,
      circuitBreaker: breaker,
    }).call({ userContent: 'x' });
    await vi.advanceTimersByTimeAsync(200);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('longer than 200ms'));
  });

  it('an abort while prepare is waiting ends the call with aborted, and nothing is dispatched', async () => {
    const { client, create } = createMockClient([jsonResponse({ ok: true })]);
    const { breaker, order } = adapter({ prepare: () => new Promise(() => {}) });
    const controller = new AbortController();

    const pending = new VernLLM({
      client,
      model: 'm',
      circuitBreaker: breaker,
      maxRetries: 0,
    }).call({ userContent: 'x', signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ type: 'aborted' });
    expect(create).not.toHaveBeenCalled();
    expect(order).not.toContain('assertClosed');
  });

  it('also runs prepare for each target in a fallback chain', async () => {
    const primary = createMockClient([new Error('primary down')]);
    const secondary = createMockClient([jsonResponse({ from: 'fallback' })]);
    const primaryBreaker = adapter({ prepare: vi.fn(async () => undefined) });
    const fallbackBreaker = adapter({ prepare: vi.fn(async () => undefined) });

    const llm = new VernLLM({
      client: primary.client,
      model: 'primary-model',
      maxRetries: 0,
      circuitBreaker: primaryBreaker.breaker,
      fallback: {
        client: secondary.client,
        model: 'fallback-model',
        circuitBreaker: fallbackBreaker.breaker,
      },
    });

    await expect(llm.call({ userContent: 'x' })).resolves.toEqual({ from: 'fallback' });
    expect(primaryBreaker.breaker.prepare).toHaveBeenCalledTimes(1);
    expect(fallbackBreaker.breaker.prepare).toHaveBeenCalledTimes(1);
  });

  it('an abort raised synchronously inside a pending prepare ends the call with aborted', async () => {
    const { client, create } = createMockClient([jsonResponse({ ok: true })]);
    const controller = new AbortController();
    const { breaker } = adapter({
      prepare: () => {
        controller.abort();
        return new Promise<void>(() => {});
      },
    });

    const llm = new VernLLM({ client, model: 'm', circuitBreaker: breaker });

    await expect(llm.call({ userContent: 'x', signal: controller.signal })).rejects.toMatchObject({
      type: 'aborted',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('an abort while a fallback target is preparing ends the chain with aborted', async () => {
    const primary = createMockClient([new Error('primary down')]);
    const secondary = createMockClient([jsonResponse({ from: 'fallback' })]);
    const controller = new AbortController();
    const fallbackBreaker = adapter({
      prepare: () => {
        queueMicrotask(() => controller.abort());
        return new Promise(() => {});
      },
    });

    const llm = new VernLLM({
      client: primary.client,
      model: 'primary-model',
      maxRetries: 0,
      fallback: {
        client: secondary.client,
        model: 'fallback-model',
        circuitBreaker: fallbackBreaker.breaker,
      },
    });

    await expect(llm.call({ userContent: 'x', signal: controller.signal })).rejects.toBeDefined();
    expect(secondary.create).not.toHaveBeenCalled();
  });
});
