import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PREPARE_TIMEOUT_MS,
  runPrepare,
  type PreparableBreaker,
} from '../../../../../src/internal/utils/circuit-breaker/prepareBreaker.utils.js';
import { createMiddlewareStateBag } from '../../../../../src/types/middleware.js';

import type { CircuitBreakerCallContext } from '../../../../../src/circuitBreaker.js';

function breaker(
  prepare: PreparableBreaker['prepare'],
  prepareTimeoutMs?: number,
): PreparableBreaker {
  return {
    assertClosed: () => {},
    recordSuccess: () => {},
    recordFailure: () => {},
    onStateChange: () => {},
    prepare,
    prepareTimeoutMs,
  };
}

function logger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function context(signal?: AbortSignal): CircuitBreakerCallContext {
  return { requestId: 'r', state: createMiddlewareStateBag(), signal };
}

describe('runPrepare', () => {
  afterEach(() => vi.useRealTimers());

  it('calls prepare on the adapter with the model and context, and resolves quietly', async () => {
    const prepare = vi.fn(async () => undefined);
    const log = logger();
    const ctx = context();

    await runPrepare(breaker(prepare), 'gpt', ctx, log);

    expect(prepare).toHaveBeenCalledWith('gpt', ctx);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('keeps `this` bound to the adapter', async () => {
    const adapter = breaker(async function (this: unknown) {
      expect(this).toBe(adapter);
    });

    await runPrepare(adapter, 'gpt', undefined, logger());
  });

  it('accepts a prepare that returns a plain value instead of a promise', async () => {
    const log = logger();

    await expect(
      runPrepare(breaker((() => undefined) as never), 'gpt', undefined, log),
    ).resolves.toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('fails open on a rejection: warns and resolves', async () => {
    const log = logger();

    await runPrepare(
      breaker(async () => {
        throw new Error('redis is down');
      }),
      'gpt',
      undefined,
      log,
    );

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('redis is down'));
  });

  it('describes a rejection that is not an Error', async () => {
    const log = logger();

    await runPrepare(
      breaker(() => Promise.reject('plain string')),
      'gpt',
      undefined,
      log,
    );

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('plain string'));
  });

  it('fails open on a synchronous throw', async () => {
    const log = logger();

    await runPrepare(
      breaker(() => {
        throw new Error('threw before returning a promise');
      }),
      'gpt',
      undefined,
      log,
    );

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('threw before returning'));
  });

  it('gives up after the default timeout, warns, and carries on', async () => {
    vi.useFakeTimers();
    const log = logger();

    const running = runPrepare(
      breaker(() => new Promise(() => {})),
      'gpt',
      undefined,
      log,
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_PREPARE_TIMEOUT_MS - 1);
    expect(log.warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await running;

    expect(DEFAULT_PREPARE_TIMEOUT_MS).toBe(1000);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('longer than 1000ms'));
  });

  it("uses the adapter's own prepareTimeoutMs when it declares one", async () => {
    vi.useFakeTimers();
    const log = logger();

    const running = runPrepare(
      breaker(() => new Promise(() => {}), 50),
      'gpt',
      undefined,
      log,
    );
    await vi.advanceTimersByTimeAsync(50);
    await running;

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('longer than 50ms'));
  });

  it('clears its timer once prepare settles, so nothing is left running', async () => {
    vi.useFakeTimers();

    await runPrepare(
      breaker(async () => undefined),
      'gpt',
      undefined,
      logger(),
    );

    expect(vi.getTimerCount()).toBe(0);
  });

  it('a prepare that rejects after the timeout already won is still handled', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    let rejectLate!: (error: Error) => void;

    const running = runPrepare(
      breaker(() => new Promise((_resolve, reject) => (rejectLate = reject)), 10),
      'gpt',
      undefined,
      logger(),
    );
    await vi.advanceTimersByTimeAsync(10);
    await running;

    rejectLate(new Error('too late'));
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
  });

  it('rejects with aborted, without calling prepare, when the signal is already aborted', async () => {
    const prepare = vi.fn(async () => undefined);
    const controller = new AbortController();
    controller.abort();

    await expect(
      runPrepare(breaker(prepare), 'gpt', context(controller.signal), logger()),
    ).rejects.toMatchObject({ type: 'aborted' });

    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects with aborted the moment the signal aborts mid wait, and removes its listener', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const running = runPrepare(
      breaker(() => new Promise(() => {})),
      'gpt',
      context(controller.signal),
      logger(),
    );
    controller.abort();

    await expect(running).rejects.toMatchObject({ type: 'aborted' });
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('removes the abort listener after a normal finish too', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await runPrepare(
      breaker(async () => undefined),
      'gpt',
      context(controller.signal),
      logger(),
    );

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
