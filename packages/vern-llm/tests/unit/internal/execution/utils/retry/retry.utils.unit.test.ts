import { describe, expect, it, vi } from 'vitest';

import {
  extractStatus,
  normalizeError,
} from '../../../../../../src/internal/execution/utils/errors.utils.js';
import { emitEvent } from '../../../../../../src/internal/execution/utils/middleware/middleware.utils.js';
import {
  getBackoffDelay,
  normalizeMaxRetries,
  recoverDelay,
  retryWithBackoff,
  shouldRetry,
  waitForRetry,
  withTimeout,
  type RecoverDelayParams,
} from '../../../../../../src/internal/execution/utils/retry/retry.utils.js';
import { NoopLogger } from '../../../../../../src/internal/utils/logger.utils.js';
import { LLMError, type LLMRequestSnapshot } from '../../../../../../src/types/errors.js';
import { createMiddlewareStateBag } from '../../../../../../src/types/middleware.js';
import { headersOf } from './retry.helpers.js';

import type { AttemptContext, RetryAttempt } from '../../../../../../src/types/index.js';

function baseRecoverDelayParams(overrides: Partial<RecoverDelayParams> = {}): RecoverDelayParams {
  return {
    requestId: 'req-1',
    model: 'gpt-test',
    attempt: 1,
    error: new Error('boom'),
    state: createMiddlewareStateBag(),
    signal: undefined,
    providerName: 'openai',
    maxRetries: 3,
    baseDelayMs: 10,
    middleware: [],
    middlewareTimeoutMs: 5000,
    logger: new NoopLogger(),
    reportEvent: vi.fn(),
    buildEventContext: (requestId, model, attempt, signal, state): AttemptContext => ({
      stage: 'attempt',
      requestId,
      requestedProvider: 'openai',
      adapter: { name: 'custom' },
      requestedModel: model,
      isFallbackAttempt: false,
      attempt: attempt + 1,
      capabilities: { supportsJsonObjectMode: true },
      signal,
      state,
      own: {},
      emit: () => {},
      context: undefined,
      registeredMiddlewareNames: [],
      transformMiddlewareNames: [],
    }),
    extractStatus,
    normalizeError,
    emitEvent,
    ...overrides,
  };
}

describe('getBackoffDelay', () => {
  /** Samples across enough attempts/iterations to bound jitter reliably. */
  function sampleRange(fn: () => number, iterations = 200): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < iterations; i++) {
      const v = fn();
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    return { min, max };
  }

  it('omitting rateLimited and serverError produces a full-jitter range of [0, exp]', () => {
    const baseDelayMs = 100;
    const attempt = 2;
    const maxDelayMs = 10_000;
    const exp = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    const { min, max } = sampleRange(() => getBackoffDelay(baseDelayMs, attempt, maxDelayMs));
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(exp);
    // full jitter should exercise well below the old half-jitter floor
    expect(min).toBeLessThan(exp / 2);
  });

  it('rateLimited produces a value in the doubled range', () => {
    const baseDelayMs = 100;
    const attempt = 2;
    const maxDelayMs = 10_000;
    const exp = Math.min(baseDelayMs * 2 * 2 ** attempt, maxDelayMs);
    const { min, max } = sampleRange(() =>
      getBackoffDelay(baseDelayMs, attempt, maxDelayMs, true, false),
    );
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(exp);
    // distinct from the default range
    expect(max).toBeGreaterThan(baseDelayMs * 2 ** attempt);
  });

  it('serverError produces a value in the 1.5x range, distinct from default and rateLimited', () => {
    const baseDelayMs = 100;
    const attempt = 2;
    const maxDelayMs = 10_000;
    const exp = Math.min(baseDelayMs * 1.5 * 2 ** attempt, maxDelayMs);
    const { min, max } = sampleRange(() =>
      getBackoffDelay(baseDelayMs, attempt, maxDelayMs, false, true),
    );
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(exp);
    expect(max).toBeGreaterThan(baseDelayMs * 2 ** attempt);
    expect(max).toBeLessThan(baseDelayMs * 2 * 2 ** attempt);
  });

  it('rateLimited wins when both rateLimited and serverError are true', () => {
    const baseDelayMs = 100;
    const attempt = 2;
    const maxDelayMs = 10_000;
    const expRateLimited = Math.min(baseDelayMs * 2 * 2 ** attempt, maxDelayMs);
    const { min, max } = sampleRange(() =>
      getBackoffDelay(baseDelayMs, attempt, maxDelayMs, true, true),
    );
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(expRateLimited);
  });

  it('caps every curve at maxDelayMs, default, rateLimited, and serverError', () => {
    const baseDelayMs = 100;
    const attempt = 20; // high enough to hit the cap under every multiplier
    const maxDelayMs = 10_000;

    for (const [rateLimited, serverError] of [
      [false, false],
      [true, false],
      [false, true],
    ] as const) {
      const { max } = sampleRange(
        () => getBackoffDelay(baseDelayMs, attempt, maxDelayMs, rateLimited, serverError),
        50,
      );
      expect(max).toBeLessThanOrEqual(maxDelayMs);
    }
  });
});

describe('shouldRetry', () => {
  it('returns false when the signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    expect(shouldRetry(new Error('boom'), [], extractStatus, controller.signal)).toBe(false);
  });

  it('returns false for a non-retryable LLMError type regardless of status', () => {
    const error = new LLMError('bad input', 'invalid_params');
    expect(shouldRetry(error, [], extractStatus)).toBe(false);
  });

  it('returns true for a retryable LLMError type', () => {
    const error = new LLMError('server exploded', 'api', { status: 500 });
    expect(shouldRetry(error, [], extractStatus)).toBe(true);
  });

  it('returns false when the error status is in nonRetryableStatus', () => {
    const error = { status: 400 };
    expect(shouldRetry(error, [400, 404], extractStatus)).toBe(false);
  });

  it('returns true when the error status is not in nonRetryableStatus', () => {
    const error = { status: 500 };
    expect(shouldRetry(error, [400, 404], extractStatus)).toBe(true);
  });

  it('returns true for a plain error with no status and no nonRetryableStatus match', () => {
    expect(shouldRetry(new Error('boom'), [400], extractStatus)).toBe(true);
  });
});

describe('recoverDelay', () => {
  it('waits for the computed backoff delay before resolving', async () => {
    vi.useFakeTimers();
    try {
      const params = baseRecoverDelayParams({ baseDelayMs: 1000, attempt: 1 });
      let resolved = false;

      recoverDelay(params).then(() => (resolved = true));

      // Backoff at attempt 1 with baseDelayMs 1000 is well under 5s even
      // with max jitter, so it must not still be pending here.
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(5000);
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors an explicit Retry-After header over computed backoff', async () => {
    vi.useFakeTimers();
    try {
      const error = {
        headers: { get: (name: string) => (name === 'Retry-After' ? '2' : null) },
      };
      const reportEvent = vi.fn();
      const params = baseRecoverDelayParams({ error, reportEvent, baseDelayMs: 100_000 });

      let resolved = false;
      recoverDelay(params).then(() => (resolved = true));

      await vi.advanceTimersByTimeAsync(1999);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(2);
      expect(resolved).toBe(true);

      expect(reportEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'retry', retryAfterHonored: true, delayMs: 2000 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits a retry event carrying provider, model, and attempt bookkeeping', async () => {
    vi.useFakeTimers();
    try {
      const reportEvent = vi.fn();
      const params = baseRecoverDelayParams({
        reportEvent,
        providerName: 'anthropic',
        model: 'claude-x',
        attempt: 2,
        maxRetries: 4,
      });

      const promise = recoverDelay(params);
      await vi.runAllTimersAsync();
      await promise;

      expect(reportEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'retry',
          provider: 'anthropic',
          model: 'claude-x',
          attempt: 2,
          maxRetries: 4,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs the recovery attempt, noting when Retry-After was honored', async () => {
    vi.useFakeTimers();
    try {
      const logger = new NoopLogger();
      vi.spyOn(logger, 'warn');
      const error = {
        headers: { get: (name: string) => (name === 'Retry-After' ? '1' : null) },
      };
      const params = baseRecoverDelayParams({ logger, error, attempt: 1, maxRetries: 3 });

      const promise = recoverDelay(params);
      await vi.runAllTimersAsync();
      await promise;

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('recovery attempt 1/3'));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('honoring Retry-After'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects immediately, without waiting, if the signal aborts mid-wait', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const params = baseRecoverDelayParams({ signal: controller.signal, baseDelayMs: 100_000 });

      const promise = recoverDelay(params);
      const assertion = expect(promise).rejects.toMatchObject({ type: 'aborted' });

      controller.abort();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('recoverDelay, maxRetryAfterMs', () => {
  function retryAfter(seconds: string) {
    return Object.assign(new Error('slow down'), {
      status: 429,
      headers: headersOf({ 'retry-after': seconds }),
    });
  }

  it('waits past the 10s default when the cap allows it', async () => {
    vi.useFakeTimers();
    try {
      const reportEvent = vi.fn();
      let resolved = false;

      void recoverDelay(
        baseRecoverDelayParams({ error: retryAfter('30'), maxRetryAfterMs: 60_000, reportEvent }),
      ).then(() => (resolved = true));

      await vi.advanceTimersByTimeAsync(29_999);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(resolved).toBe(true);
      expect(reportEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'retry', delayMs: 30_000, retryAfterHonored: true }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the 10s default when the cap is omitted', async () => {
    vi.useFakeTimers();
    try {
      const reportEvent = vi.fn();
      const done = recoverDelay(baseRecoverDelayParams({ error: retryAfter('30'), reportEvent }));

      await vi.advanceTimersByTimeAsync(10_000);
      await done;

      expect(reportEvent).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 10_000 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries without waiting when the cap is 0', async () => {
    vi.useFakeTimers();
    try {
      const reportEvent = vi.fn();
      const done = recoverDelay(
        baseRecoverDelayParams({ error: retryAfter('30'), maxRetryAfterMs: 0, reportEvent }),
      );

      await vi.advanceTimersByTimeAsync(0);
      await done;

      expect(reportEvent).toHaveBeenCalledWith(
        expect.objectContaining({ delayMs: 0, retryAfterHonored: true }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('waitForRetry', () => {
  it('clamps a delay beyond the setTimeout range instead of firing almost at once', async () => {
    vi.useFakeTimers();
    try {
      let resolved = false;
      void waitForRetry(Infinity).then(() => (resolved = true));

      await vi.advanceTimersByTimeAsync(1_000);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects immediately with an aborted LLMError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(waitForRetry(1000, controller.signal)).rejects.toMatchObject({
      type: 'aborted',
    });
  });
});

describe('retryWithBackoff', () => {
  function immediateRecoverDelay() {
    return vi.fn(async () => {});
  }

  it('returns the result on first success without retrying', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await retryWithBackoff({
      normalizeError,
      fn,
      maxRetries: 3,
      shouldRetryAttempt: () => true,
      recoverDelayForAttempt: immediateRecoverDelay(),
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxRetries then throws the last error', async () => {
    const fn = vi.fn(async () => {
      throw new Error('always fails');
    });
    const recoverDelayForAttempt = immediateRecoverDelay();

    await expect(
      retryWithBackoff({
        normalizeError,
        fn,
        maxRetries: 2,
        shouldRetryAttempt: () => true,
        recoverDelayForAttempt,
      }),
    ).rejects.toThrow('always fails');

    // Initial attempt (0) + 2 retries = 3 calls total.
    expect(fn).toHaveBeenCalledTimes(3);
    expect(recoverDelayForAttempt).toHaveBeenCalledTimes(2);
  });

  it('stops retrying as soon as shouldRetryAttempt returns false', async () => {
    const fn = vi.fn(async () => {
      throw new Error('non-retryable');
    });

    await expect(
      retryWithBackoff({
        normalizeError,
        fn,
        maxRetries: 5,
        shouldRetryAttempt: () => false,
        recoverDelayForAttempt: immediateRecoverDelay(),
      }),
    ).rejects.toThrow('non-retryable');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('succeeds on a later attempt after earlier ones fail', async () => {
    let call = 0;
    const fn = vi.fn(async () => {
      call += 1;
      if (call < 3) throw new Error(`fail ${call}`);
      return 'recovered';
    });

    const result = await retryWithBackoff({
      normalizeError,
      fn,
      maxRetries: 5,
      shouldRetryAttempt: () => true,
      recoverDelayForAttempt: immediateRecoverDelay(),
    });

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('records each retried-past attempt into attempts[], in order, without the terminal failure', async () => {
    const fn = vi.fn(async () => {
      throw new LLMError('nope', 'api');
    });

    const attempts: RetryAttempt[] = [];

    await expect(
      retryWithBackoff({
        normalizeError,
        fn,
        maxRetries: 2,
        attempts,
        shouldRetryAttempt: () => true,
        recoverDelayForAttempt: immediateRecoverDelay(),
      }),
    ).rejects.toThrow();

    // Two retried-past attempts (0 and 1); the terminal failure at
    // attempt 2 is never pushed since it's the thrown error itself.
    expect(attempts.map((a) => a.index)).toEqual([0, 1]);
  });

  it('leaves attempts empty when nothing was ever retried', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    const attempts: RetryAttempt[] = [];

    await expect(
      retryWithBackoff({
        normalizeError,
        fn,
        maxRetries: 3,
        attempts,
        shouldRetryAttempt: () => false,
        recoverDelayForAttempt: immediateRecoverDelay(),
      }),
    ).rejects.toThrow();

    expect(attempts).toEqual([]);
  });

  it('calls onAttempt before every attempt, including retries', async () => {
    const onAttempt = vi.fn();
    let call = 0;
    const fn = vi.fn(async () => {
      call += 1;
      if (call < 2) throw new Error('fail once');
      return 'ok';
    });

    await retryWithBackoff({
      normalizeError,
      fn,
      maxRetries: 3,
      onAttempt,
      shouldRetryAttempt: () => true,
      recoverDelayForAttempt: immediateRecoverDelay(),
    });

    expect(onAttempt).toHaveBeenCalledTimes(2);
  });

  it('calls recoverDelayForAttempt with the 0-based attempt index and the prior error', async () => {
    const recoverDelayForAttempt = vi.fn(async () => {});
    let call = 0;
    const priorError = new Error('first failure');
    const fn = vi.fn(async () => {
      call += 1;
      if (call === 1) throw priorError;
      return 'ok';
    });

    await retryWithBackoff({
      normalizeError,
      fn,
      maxRetries: 3,
      shouldRetryAttempt: () => true,
      recoverDelayForAttempt,
    });

    expect(recoverDelayForAttempt).toHaveBeenCalledWith(1, priorError);
  });

  it('does not call recoverDelayForAttempt before the first attempt', async () => {
    const recoverDelayForAttempt = vi.fn(async () => {});
    const fn = vi.fn(async () => 'ok');

    await retryWithBackoff({
      normalizeError,
      fn,
      maxRetries: 3,
      shouldRetryAttempt: () => true,
      recoverDelayForAttempt,
    });

    expect(recoverDelayForAttempt).not.toHaveBeenCalled();
  });

  it('propagates an abort thrown from recoverDelayForAttempt without another fn call', async () => {
    const fn = vi.fn(async () => {
      throw new Error('fail');
    });
    const recoverDelayForAttempt = vi.fn(async () => {
      throw new LLMError('Operation aborted', 'aborted');
    });

    await expect(
      retryWithBackoff({
        normalizeError,
        fn,
        maxRetries: 3,
        // Stops retrying once the abort thrown by recoverDelayForAttempt
        // becomes the "lastError" evaluated on the next loop iteration.
        shouldRetryAttempt: (error) => !(error instanceof LLMError && error.type === 'aborted'),
        recoverDelayForAttempt,
      }),
    ).rejects.toMatchObject({ type: 'aborted' });

    // First attempt runs and fails, recoverDelayForAttempt is invoked once
    // for the retry and itself throws, aborting before a second fn call.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(recoverDelayForAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not misattribute a previous attempt's request snapshot to a later attempt that fails before onRequest fires", async () => {
    const attempts: RetryAttempt[] = [];
    let call = 0;
    const fn = vi.fn(async (_attempt: number, onRequest: (req: LLMRequestSnapshot) => void) => {
      call += 1;
      if (call === 1) {
        onRequest({ id: 'first' } as unknown as LLMRequestSnapshot);
        throw new Error('fail after building request');
      }
      // Second attempt fails before ever calling onRequest.
      throw new Error('fail before building request');
    });

    await expect(
      retryWithBackoff({
        normalizeError,
        fn,
        maxRetries: 2,
        attempts,
        shouldRetryAttempt: () => true,
        recoverDelayForAttempt: immediateRecoverDelay(),
      }),
    ).rejects.toThrow();

    expect(attempts[0]?.request).toEqual({ id: 'first' });
    expect(attempts[1]?.request).toBeUndefined();
  });

  it('times out a client that ignores the abort signal', async () => {
    vi.useFakeTimers();
    try {
      const result = withTimeout(() => new Promise<string>(() => {}), 50);
      const assertion = expect(result).rejects.toMatchObject({
        type: 'timeout',
        code: 'request_timeout',
      });

      await vi.advanceTimersByTimeAsync(50);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('converts a non DOMException abort error into a timeout', async () => {
    vi.useFakeTimers();
    try {
      class SdkAbortError extends Error {}
      const fn = (signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new SdkAbortError('aborted')));
        });

      const result = withTimeout(fn, 50);
      const assertion = expect(result).rejects.toMatchObject({ type: 'timeout' });

      await vi.advanceTimersByTimeAsync(50);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('still propagates the raw error when the external signal aborted', async () => {
    const external = new AbortController();
    const boom = new Error('external');
    const fn = (signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(boom));
      });

    const result = withTimeout(fn, 10_000, external.signal);
    external.abort();

    await expect(result).rejects.toBe(boom);
  });
});

describe('normalizeMaxRetries', () => {
  it.each([
    [2, 2],
    [0, 0],
    [2.9, 2],
    [-1, 0],
    [-Infinity, 0],
    [Number.NaN, 0],
    [Infinity, Infinity],
    [undefined as unknown as number, 0],
    ['3' as unknown as number, 0],
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeMaxRetries(input)).toBe(expected);
  });
});

describe('retryWithBackoff with an invalid maxRetries', () => {
  it.each([-1, Number.NaN])(
    'still makes one attempt for maxRetries %s instead of none',
    async (maxRetries) => {
      const fn = vi.fn(async () => {
        throw new Error('provider down');
      });

      await expect(
        retryWithBackoff({
          normalizeError,
          fn,
          maxRetries,
          shouldRetryAttempt: () => true,
          recoverDelayForAttempt: vi.fn(async () => {}),
        }),
      ).rejects.toThrow('provider down');

      expect(fn).toHaveBeenCalledTimes(1);
    },
  );

  it('returns the result of that single attempt', async () => {
    const result = await retryWithBackoff({
      normalizeError,
      fn: async () => 'ok',
      maxRetries: Number.NaN,
      shouldRetryAttempt: () => true,
      recoverDelayForAttempt: vi.fn(async () => {}),
    });

    expect(result).toBe('ok');
  });
});
