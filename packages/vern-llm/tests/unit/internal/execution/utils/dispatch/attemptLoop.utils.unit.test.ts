import { describe, expect, it, vi } from 'vitest';

import { CircuitBreaker } from '../../../../../../src/circuitBreaker.js';
import { runAttemptLoop } from '../../../../../../src/internal/execution/utils/dispatch/attemptLoop.utils.js';
import { RetryBudget } from '../../../../../../src/internal/retryBudget.js';
import { LLMError } from '../../../../../../src/types/errors.js';

/** Matches the local `noopLogger` helper other execution tests use (see `retry.utils.unit.test.ts`). */
function noopLogger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function baseParams(
  overrides: Partial<Parameters<typeof runAttemptLoop>[0]> = {},
): Parameters<typeof runAttemptLoop>[0] {
  return {
    fn: vi.fn(async () => 'ok'),
    requestId: 'req-1',
    model: 'gpt-test',
    providerName: 'openai',
    isFallback: false,
    supportsJsonObjectMode: true,
    breaker: undefined,
    maxRetries: 0,
    baseDelayMs: 0,
    nonRetryableStatus: [],
    middleware: [],
    middlewareTimeoutMs: 5000,
    logger: noopLogger(),
    reportEvent: vi.fn(),
    logLabel: 'error',
    redactText: (text) => text,
    countsTowardBreaker: (error) => error.retryable,
    ...overrides,
  };
}

describe('runAttemptLoop, success', () => {
  it("resolves with fn's result on the first attempt", async () => {
    const fn = vi.fn(async () => 'result');

    const result = await runAttemptLoop(baseParams({ fn }));

    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('passes a 0-based attempt number, a working onRequest, a state bag, and a gateway to fn', async () => {
    const fn = vi.fn(async (attempt, onRequest, state, gateway) => {
      expect(attempt).toBe(0);
      expect(typeof onRequest).toBe('function');
      expect(typeof state.get).toBe('function');
      expect(typeof gateway.buildAttemptContext).toBe('function');
      return 'ok';
    });

    await runAttemptLoop(baseParams({ fn }));

    expect(fn).toHaveBeenCalledOnce();
  });

  it('reuses the passed-in state bag across retries instead of creating a new one per attempt', async () => {
    const seenStates = new Set<unknown>();
    const fn = vi.fn(async (attempt: number, _onRequest: unknown, state: unknown) => {
      seenStates.add(state);
      if (attempt === 0) throw new LLMError('transient', 'api');
      return 'ok';
    });

    await runAttemptLoop(baseParams({ fn, maxRetries: 1 }));

    expect(seenStates.size).toBe(1);
  });
});

describe('runAttemptLoop, retries', () => {
  it('retries a retryable failure up to maxRetries, then succeeds', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new LLMError('transient', 'api');
      return 'ok';
    });

    const result = await runAttemptLoop(baseParams({ fn, maxRetries: 2 }));

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-retryable error even when maxRetries allows it', async () => {
    const fn = vi.fn(async () => {
      throw new LLMError('bad request', 'validation');
    });

    await expect(runAttemptLoop(baseParams({ fn, maxRetries: 3 }))).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('calls onAttempt once per attempt, including retries', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 2) throw new LLMError('transient', 'api');
      return 'ok';
    });
    const onAttempt = vi.fn();

    await runAttemptLoop(baseParams({ fn, maxRetries: 1, onAttempt }));

    expect(onAttempt).toHaveBeenCalledTimes(2);
  });
});

describe('runAttemptLoop, terminal failure', () => {
  it('normalizes and rethrows the terminal error after retries are exhausted', async () => {
    const fn = vi.fn(async () => {
      throw new LLMError('always fails', 'api');
    });

    await expect(runAttemptLoop(baseParams({ fn, maxRetries: 1 }))).rejects.toMatchObject({
      message: 'always fails',
      name: 'LLMError',
    });
  });

  it('logs the terminal failure under the given logLabel, redacted', async () => {
    const fn = vi.fn(async () => {
      throw new LLMError('secret leaked', 'api');
    });
    const logger = noopLogger();
    const redactText = vi.fn((text: string) => text.replace('secret leaked', '[redacted]'));

    await expect(
      runAttemptLoop(
        baseParams({ fn, maxRetries: 0, logLabel: 'stream-open error', logger, redactText }),
      ),
    ).rejects.toThrow();

    expect(redactText).toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('[VernLLM:req-1] stream-open error:'),
    );
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('[redacted]'));
    expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining('secret leaked'));
  });

  it('records the failure against the breaker only when countsTowardBreaker says so', async () => {
    const breaker = new CircuitBreaker({ threshold: 5, cooldownMs: 1000 });
    const recordFailureSpy = vi.spyOn(breaker, 'recordFailure');
    const fn = vi.fn(async () => {
      throw new LLMError('non-retryable', 'validation');
    });

    await expect(
      runAttemptLoop(baseParams({ fn, maxRetries: 0, breaker, countsTowardBreaker: () => false })),
    ).rejects.toThrow();

    expect(recordFailureSpy).not.toHaveBeenCalled();
  });

  it('does not record a breaker failure for a quota_exceeded error that fails mid-attempt, using the real countsTowardBreaker check', async () => {
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 10_000 });
    const recordFailureSpy = vi.spyOn(breaker, 'recordFailure');
    const fn = vi.fn(async () => {
      throw new LLMError('quota gone', 'quota_exceeded');
    });
    // The real getter, not a stub: `quota_exceeded` is retryable but
    // still excluded from breaker accounting, and that distinction is
    // exactly what this test needs to exercise.
    const params = baseParams({
      fn,
      maxRetries: 0,
      breaker,
      countsTowardBreaker: (error) => error.countsTowardBreaker,
    });

    await expect(runAttemptLoop(params)).rejects.toThrow();
    expect(recordFailureSpy).not.toHaveBeenCalled();
    expect(breaker.getState()).toBe('closed');

    // A second attempt-level quota_exceeded failure still doesn't move
    // the breaker, confirming this isn't just "one failure under
    // threshold" but a genuine, repeatable exclusion.
    await expect(runAttemptLoop(params)).rejects.toThrow();
    expect(recordFailureSpy).not.toHaveBeenCalled();
    expect(breaker.getState()).toBe('closed');
  });

  it('records the failure against the breaker with the 1-based attempt count that exhausted the loop', async () => {
    const breaker = new CircuitBreaker({ threshold: 5, cooldownMs: 1000 });
    const recordFailureSpy = vi.spyOn(breaker, 'recordFailure');
    const fn = vi.fn(async () => {
      throw new LLMError('always fails', 'api');
    });

    await expect(
      runAttemptLoop(baseParams({ fn, maxRetries: 2, baseDelayMs: 0, breaker })),
    ).rejects.toThrow();

    // 3 total attempts (0, 1, 2) were made; `attempts` only holds the two
    // retried-past ones, so the exhausting attempt is `attempts.length` (2),
    // converted to 1-based (3) inside the gateway.
    expect(recordFailureSpy).toHaveBeenCalledExactlyOnceWith(
      'gpt-test',
      expect.objectContaining({ attempt: 3 }),
      undefined,
    );
  });

  it("forwards the exhausting error's own code to the breaker, not just undefined", async () => {
    const breaker = new CircuitBreaker({ threshold: 5, cooldownMs: 1000 });
    const recordFailureSpy = vi.spyOn(breaker, 'recordFailure');
    const fn = vi.fn(async () => {
      throw new LLMError('provider down', 'api', { code: 'server_error' });
    });

    await expect(runAttemptLoop(baseParams({ fn, maxRetries: 0, breaker }))).rejects.toThrow();

    expect(recordFailureSpy).toHaveBeenCalledExactlyOnceWith(
      'gpt-test',
      expect.objectContaining({ attempt: 1 }),
      'server_error',
    );
  });

  it('is a no-op against the breaker when none is configured', async () => {
    const fn = vi.fn(async () => {
      throw new LLMError('always fails', 'api');
    });

    await expect(
      runAttemptLoop(baseParams({ fn, maxRetries: 0, breaker: undefined })),
    ).rejects.toThrow();
    // No assertion needed beyond not throwing from a missing breaker.
  });
});

describe('runAttemptLoop, retry budget', () => {
  it('throws the budget-exhausted error, not the failure that happened to be current, once the budget trips', async () => {
    // minCalls 1, retryRatio 0: trips on the very first retry check.
    const budget = new RetryBudget({ windowMs: 60_000, minCalls: 1, retryRatio: 0 });
    const fn = vi.fn(async () => {
      throw new LLMError('provider down', 'api', { code: 'server_error' });
    });

    await expect(runAttemptLoop(baseParams({ fn, maxRetries: 3, budget }))).rejects.toMatchObject({
      code: 'retry_budget_exhausted',
      type: 'rate_limited',
    });
  });

  it('still carries the prior attempts made before the budget tripped, same as any other terminal error', async () => {
    // minCalls 2: the first attempt is genuinely retried past (recorded
    // into `attempts`) before the budget cuts the loop off on the
    // second, leaving something in `attempts` to potentially lose.
    const budget = new RetryBudget({ windowMs: 60_000, minCalls: 2, retryRatio: 0 });
    const fn = vi.fn(async () => {
      throw new LLMError('provider down', 'api', { code: 'server_error' });
    });

    await expect(runAttemptLoop(baseParams({ fn, maxRetries: 5, budget }))).rejects.toMatchObject({
      code: 'retry_budget_exhausted',
      attempts: [
        expect.objectContaining({
          index: 0,
          error: expect.objectContaining({ code: 'server_error' }),
        }),
      ],
    });
  });

  it('records recordAttempt(false) on the first attempt and recordAttempt(true) on every retry', async () => {
    const budget = new RetryBudget({ windowMs: 60_000, minCalls: 100, retryRatio: 1 });
    const recordAttemptSpy = vi.spyOn(budget, 'recordAttempt');
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new LLMError('transient', 'api');
      return 'ok';
    });

    await runAttemptLoop(baseParams({ fn, maxRetries: 2, budget }));

    expect(recordAttemptSpy).toHaveBeenCalledTimes(3);
    expect(recordAttemptSpy).toHaveBeenNthCalledWith(1, false);
    expect(recordAttemptSpy).toHaveBeenNthCalledWith(2, true);
    expect(recordAttemptSpy).toHaveBeenNthCalledWith(3, true);
  });

  it('does not count a budget-exhausted terminal error toward the breaker, since it is not retryable', async () => {
    const breaker = new CircuitBreaker({ threshold: 5, cooldownMs: 1000 });
    const recordFailureSpy = vi.spyOn(breaker, 'recordFailure');
    const budget = new RetryBudget({ windowMs: 60_000, minCalls: 1, retryRatio: 0 });
    const fn = vi.fn(async () => {
      throw new LLMError('provider down', 'api', { code: 'server_error' });
    });

    await expect(
      runAttemptLoop(
        baseParams({
          fn,
          maxRetries: 3,
          breaker,
          budget,
          countsTowardBreaker: (error) => error.countsTowardBreaker,
        }),
      ),
    ).rejects.toThrow();

    expect(recordFailureSpy).not.toHaveBeenCalled();
  });
});
