import { describe, it, expect, vi } from 'vitest';

import {
  extractStatus,
  normalizeError,
} from '../../../../../../src/internal/execution/utils/errors.utils.js';
import { emitEvent } from '../../../../../../src/internal/execution/utils/middleware.utils.js';
import {
  extractRetryAfterMs,
  getBackoffDelay,
  recoverDelay,
  retryWithBackoff,
  shouldRetry,
  withChunkIdleTimeout,
  withTimeout,
  type RecoverDelayParams,
} from '../../../../../../src/internal/execution/utils/retry/retry.utils.js';
import { LLMError, type LLMRequestSnapshot } from '../../../../../../src/types/errors.js';
import { createMiddlewareStateBag } from '../../../../../../src/types/middleware.js';

import type { AttemptContext, RetryAttempt } from '../../../../../../src/types/index.js';

function noopLogger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

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
    logger: noopLogger(),
    reportEvent: vi.fn(),
    buildEventContext: (requestId, model, attempt, signal, state): AttemptContext => ({
      stage: 'attempt',
      requestId,
      requestedProvider: 'openai',
      requestedModel: model,
      isFallbackAttempt: false,
      attempt: attempt + 1,
      capabilities: { supportsJsonObjectMode: true },
      signal,
      state,
      own: {},
    }),
    extractStatus,
    normalizeError,
    emitEvent,
    ...overrides,
  };
}

/** Mirrors the internal MAX_SETTIMEOUT_MS constant, setTimeout's real ceiling (~24.8 days). */
const MAX_SETTIMEOUT_MS = 2_147_483_647;

function headersOf(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

describe('extractRetryAfterMs', () => {
  it('returns undefined when the error is not an object', () => {
    expect(extractRetryAfterMs('nope')).toBeUndefined();
    expect(extractRetryAfterMs(undefined)).toBeUndefined();
  });

  it('returns undefined when there are no headers at all', () => {
    expect(extractRetryAfterMs(new Error('boom'))).toBeUndefined();
  });

  it('returns undefined when Retry-After is absent from the headers', () => {
    const err = { headers: headersOf({ 'Content-Type': 'application/json' }) };
    expect(extractRetryAfterMs(err)).toBeUndefined();
  });

  it('parses a delta-seconds Retry-After from a Headers-like .headers', () => {
    const err = { headers: headersOf({ 'Retry-After': '5' }) };
    expect(extractRetryAfterMs(err)).toBe(5_000);
  });

  it('parses a delta-seconds Retry-After from axios-style .response.headers', () => {
    const err = { response: { headers: { 'retry-after': '3' } } };
    expect(extractRetryAfterMs(err)).toBe(3_000);
  });

  it('matches a plain-object header name case-insensitively (canonical casing)', () => {
    const err = { response: { headers: { 'Retry-After': '3' } } };
    expect(extractRetryAfterMs(err)).toBe(3_000);
  });

  it('parses an HTTP-date Retry-After relative to now', () => {
    const future = new Date(Date.now() + 4_000).toUTCString();
    const err = { headers: headersOf({ 'Retry-After': future }) };
    const result = extractRetryAfterMs(err);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(4_000);
  });

  it('treats a past HTTP-date as absent instead of a negative delay', () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    const err = { headers: headersOf({ 'Retry-After': past }) };
    expect(extractRetryAfterMs(err)).toBeUndefined();
  });

  it('caps an oversized delta-seconds value at maxDelayMs', () => {
    const err = { headers: headersOf({ 'Retry-After': '3600' }) };
    expect(extractRetryAfterMs(err, 10_000)).toBe(10_000);
  });

  it('returns undefined for an unparseable Retry-After value', () => {
    const err = { headers: headersOf({ 'Retry-After': 'not-a-value' }) };
    expect(extractRetryAfterMs(err)).toBeUndefined();
  });

  it('ignores a plain object without a .get method that has no retry-after key', () => {
    const err = { headers: { 'content-type': 'application/json' } };
    expect(extractRetryAfterMs(err)).toBeUndefined();
  });

  it('parses a decimal delta-seconds Retry-After value', () => {
    const err = { headers: headersOf({ 'Retry-After': '1.5' }) };
    expect(extractRetryAfterMs(err)).toBe(1_500);
  });

  it('treats a negative delta-seconds Retry-After as absent instead of 0', () => {
    const err = { headers: headersOf({ 'Retry-After': '-5' }) };
    expect(extractRetryAfterMs(err)).toBeUndefined();
  });

  it('prefers a retry-after-ms header over the standard Retry-After header', () => {
    const err = { headers: headersOf({ 'retry-after-ms': '250', 'Retry-After': '30' }) };
    expect(extractRetryAfterMs(err)).toBe(250);
  });

  it('uses a retry-after-ms header directly, without multiplying by 1000', () => {
    const err = { headers: headersOf({ 'retry-after-ms': '750' }) };
    expect(extractRetryAfterMs(err)).toBe(750);
  });

  it('falls back to x-retry-after-ms when retry-after-ms is absent', () => {
    const err = { headers: headersOf({ 'x-retry-after-ms': '400' }) };
    expect(extractRetryAfterMs(err)).toBe(400);
  });

  it('reads a millisecond header from axios-style plain-object headers', () => {
    const err = { response: { headers: { 'retry-after-ms': '600' } } };
    expect(extractRetryAfterMs(err)).toBe(600);
  });

  it('ignores a matching plain-object header whose value is not a string, instead of throwing', () => {
    const err = { response: { headers: { 'retry-after-ms': 600 } } };
    expect(() => extractRetryAfterMs(err)).not.toThrow();
    expect(extractRetryAfterMs(err)).toBeUndefined();
  });

  it('caps an oversized retry-after-ms value at maxDelayMs', () => {
    const err = { headers: headersOf({ 'retry-after-ms': '999999' }) };
    expect(extractRetryAfterMs(err, 10_000)).toBe(10_000);
  });

  it('treats a negative retry-after-ms value as absent instead of 0', () => {
    const err = { headers: headersOf({ 'retry-after-ms': '-100' }) };
    expect(extractRetryAfterMs(err)).toBeUndefined();
  });
});

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

  it('omitting rateLimited and serverError reproduces the pre-change range', () => {
    const baseDelayMs = 100;
    const attempt = 2;
    const maxDelayMs = 10_000;
    const exp = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    const { min, max } = sampleRange(() => getBackoffDelay(baseDelayMs, attempt, maxDelayMs));
    expect(min).toBeGreaterThanOrEqual(exp / 2);
    expect(max).toBeLessThanOrEqual(exp);
  });

  it('rateLimited produces a value in the doubled range', () => {
    const baseDelayMs = 100;
    const attempt = 2;
    const maxDelayMs = 10_000;
    const exp = Math.min(baseDelayMs * 2 * 2 ** attempt, maxDelayMs);
    const { min, max } = sampleRange(() =>
      getBackoffDelay(baseDelayMs, attempt, maxDelayMs, true, false),
    );
    expect(min).toBeGreaterThanOrEqual(exp / 2);
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
    expect(min).toBeGreaterThanOrEqual(exp / 2);
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
    expect(min).toBeGreaterThanOrEqual(expRateLimited / 2);
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

describe('withTimeout', () => {
  it('treats Infinity as disabling the timeout instead of clamping to ~1ms', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const fn = () => new Promise<string>(() => {});

      withTimeout(fn, Infinity).then(
        () => (settled = true),
        () => (settled = true),
      );

      await vi.advanceTimersByTimeAsync(100_000_000);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps a timeout above MAX_SETTIMEOUT_MS instead of firing almost immediately', async () => {
    vi.useFakeTimers();
    try {
      let rejected = false;
      const fn = (signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
        });

      withTimeout(fn, MAX_SETTIMEOUT_MS + 10_000).catch(() => (rejected = true));

      await vi.advanceTimersByTimeAsync(5_000);
      expect(rejected).toBe(false);

      await vi.advanceTimersByTimeAsync(MAX_SETTIMEOUT_MS);
      expect(rejected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('withChunkIdleTimeout', () => {
  it('treats Infinity as disabling the idle timeout instead of clamping to ~1ms', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const next = () => new Promise<IteratorResult<string>>(() => {});

      withChunkIdleTimeout(next, Infinity).then(
        () => (settled = true),
        () => (settled = true),
      );

      await vi.advanceTimersByTimeAsync(100_000_000);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps a timeout above MAX_SETTIMEOUT_MS instead of firing almost immediately', async () => {
    vi.useFakeTimers();
    try {
      let rejected = false;
      const next = () => new Promise<IteratorResult<string>>(() => {});

      withChunkIdleTimeout(next, MAX_SETTIMEOUT_MS + 10_000).catch(() => (rejected = true));

      await vi.advanceTimersByTimeAsync(5_000);
      expect(rejected).toBe(false);

      await vi.advanceTimersByTimeAsync(MAX_SETTIMEOUT_MS);
      expect(rejected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls onIdle when the timer fires, before rejecting, so the caller can abort the transport', async () => {
    vi.useFakeTimers();
    try {
      const next = () => new Promise<IteratorResult<string>>(() => {});
      const onIdle = vi.fn();

      const promise = withChunkIdleTimeout(next, 500, onIdle);
      const assertion = expect(promise).rejects.toMatchObject({ type: 'timeout' });

      await vi.advanceTimersByTimeAsync(500);
      await assertion;

      expect(onIdle).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with the idle timeout error once next() has not settled in time', async () => {
    vi.useFakeTimers();
    try {
      const next = () => new Promise<IteratorResult<string>>(() => {});

      const promise = withChunkIdleTimeout(next, 1_000);
      const assertion = expect(promise).rejects.toMatchObject({ type: 'timeout' });

      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves normally, with no timer left running, when next() settles before the idle timeout', async () => {
    vi.useFakeTimers();
    try {
      const next = () => Promise.resolve({ done: false, value: 'chunk' });

      const result = await withChunkIdleTimeout(next, 1_000);

      expect(result).toEqual({ done: false, value: 'chunk' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs and discards a chunk that resolves after the idle timeout already fired, instead of losing it silently', async () => {
    vi.useFakeTimers();
    try {
      let resolveNext!: (value: IteratorResult<string>) => void;
      const next = () =>
        new Promise<IteratorResult<string>>((resolve) => {
          resolveNext = resolve;
        });
      const logger = { debug: vi.fn() };

      const promise = withChunkIdleTimeout(next, 1_000, undefined, logger);
      const assertion = expect(promise).rejects.toMatchObject({ type: 'timeout' });

      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      // The late chunk finally arrives, after the idle timeout already
      // rejected. Without the settled-guard this would otherwise be a
      // silent no-op with no trace of why it went missing.
      resolveNext({ done: false, value: 'too late' });
      await vi.advanceTimersByTimeAsync(0);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('chunk resolved after idle timeout already fired'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs and discards a rejection that arrives after the idle timeout already fired', async () => {
    vi.useFakeTimers();
    try {
      let rejectNext!: (error: unknown) => void;
      const next = () =>
        new Promise<IteratorResult<string>>((_resolve, reject) => {
          rejectNext = reject;
        });
      const logger = { debug: vi.fn() };

      const promise = withChunkIdleTimeout(next, 1_000, undefined, logger);
      const assertion = expect(promise).rejects.toMatchObject({ type: 'timeout' });

      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      rejectNext(new Error('late transport error'));
      await vi.advanceTimersByTimeAsync(0);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('chunk rejection arrived after idle timeout already fired'),
      );
    } finally {
      vi.useRealTimers();
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
      const logger = noopLogger();
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
        attempts: attempts as never,
        shouldRetryAttempt: () => true,
        recoverDelayForAttempt: immediateRecoverDelay(),
      }),
    ).rejects.toThrow();

    expect(attempts[0]?.request).toEqual({ id: 'first' });
    expect(attempts[1]?.request).toBeUndefined();
  });
});
