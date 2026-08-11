import { describe, it, expect, vi } from 'vitest';

import {
  extractRetryAfterMs,
  normalizeError,
  withReservedUsage,
  withTimeout,
  withChunkIdleTimeout,
} from '../../src/internal/vernLLM.utils.js';
import { LLMError } from '../../src/types/errors.js';

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

  it('clamps a past HTTP-date to 0 instead of a negative delay', () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    const err = { headers: headersOf({ 'Retry-After': past }) };
    expect(extractRetryAfterMs(err)).toBe(0);
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
});

describe('normalizeError', () => {
  it('returns an aborted LLMError when the signal is already aborted, regardless of the error', () => {
    const controller = new AbortController();
    controller.abort();

    const result = normalizeError(new Error('boom'), controller.signal);

    expect(result).toBeInstanceOf(LLMError);
    expect(result.type).toBe('aborted');
  });

  it('passes an existing LLMError through unchanged', () => {
    const original = new LLMError('already normalized', 'validation');

    expect(normalizeError(original)).toBe(original);
  });

  it('tags an already-normalized LLMError carrying status 429 with code "provider_rate_limited"', () => {
    const original = new LLMError('rate limited', 'api', 429);

    const result = normalizeError(original);

    expect(result).toBe(original);
    expect(result.code).toBe('provider_rate_limited');
  });

  it('does not overwrite an existing code on an already-normalized 429 LLMError', () => {
    const original = new LLMError(
      'rate limited',
      'api',
      429,
      undefined,
      undefined,
      undefined,
      'local_rate_limit',
    );

    const result = normalizeError(original);

    expect(result.code).toBe('local_rate_limit');
  });

  it('does not add a code to an already-normalized LLMError with a non-429 status', () => {
    const original = new LLMError('server error', 'api', 500);

    const result = normalizeError(original);

    expect(result.code).toBeUndefined();
  });

  it('wraps an error carrying an http status as type "api" and preserves the status', () => {
    const result = normalizeError({ status: 500 });

    expect(result.type).toBe('api');
    expect(result.status).toBe(500);
  });

  it("falls back to AWS SDK v3's $metadata.httpStatusCode when status/statusCode are absent", () => {
    const result = normalizeError({
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 429 },
    });

    expect(result.type).toBe('api');
    expect(result.status).toBe(429);
  });

  it('carries a Retry-After value through onto the normalized error', () => {
    const err = {
      status: 429,
      headers: { get: (name: string) => (name === 'Retry-After' ? '2' : null) },
    };

    const result = normalizeError(err);

    expect(result.retryAfterMs).toBe(2_000);
  });

  it('falls back to type "unknown" when the error carries no http status', () => {
    const result = normalizeError(new Error('mystery failure'));

    expect(result.type).toBe('unknown');
    expect(result.status).toBeUndefined();
  });
});

describe('withReservedUsage', () => {
  it('runs getResult and returns its value when no reserveUsage hook is given', async () => {
    const getResult = vi.fn().mockResolvedValue('ok');
    const onRefundError = vi.fn();

    const result = await withReservedUsage({}, false, getResult, undefined, onRefundError);

    expect(result).toBe('ok');
    expect(getResult).toHaveBeenCalledOnce();
    expect(onRefundError).not.toHaveBeenCalled();
  });

  it('reserves before calling getResult and does not refund on success', async () => {
    const calls: string[] = [];
    const reserveUsage = vi.fn().mockImplementation(async () => {
      calls.push('reserve');
    });
    const refundUsage = vi.fn().mockImplementation(async () => {
      calls.push('refund');
    });
    const getResult = vi.fn().mockImplementation(async () => {
      calls.push('getResult');
      return 'done';
    });

    const result = await withReservedUsage(
      { reserveUsage, refundUsage },
      false,
      getResult,
      undefined,
      vi.fn(),
    );

    expect(result).toBe('done');
    expect(calls).toEqual(['reserve', 'getResult']);
    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('passes coalesced and signal through to reserveUsage/refundUsage', async () => {
    const controller = new AbortController();
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockResolvedValue(undefined);
    const getResult = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(
      withReservedUsage({ reserveUsage, refundUsage }, true, getResult, controller.signal, vi.fn()),
    ).rejects.toThrow('fail');

    expect(reserveUsage).toHaveBeenCalledWith({ coalesced: true, signal: controller.signal });
    expect(refundUsage).toHaveBeenCalledWith({ coalesced: true, signal: controller.signal });
  });

  it('wraps a reserveUsage failure in a quota_exceeded LLMError and never calls getResult', async () => {
    const reserveUsage = vi.fn().mockRejectedValue(new Error('no budget left'));
    const getResult = vi.fn();

    await expect(
      withReservedUsage({ reserveUsage }, false, getResult, undefined, vi.fn()),
    ).rejects.toMatchObject({ type: 'quota_exceeded', message: 'no budget left' });

    expect(getResult).not.toHaveBeenCalled();
  });

  it('refunds when getResult throws after a successful reservation, then rethrows the original error', async () => {
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockResolvedValue(undefined);
    const originalError = new Error('call failed');
    const getResult = vi.fn().mockRejectedValue(originalError);

    await expect(
      withReservedUsage({ reserveUsage, refundUsage }, false, getResult, undefined, vi.fn()),
    ).rejects.toBe(originalError);

    expect(refundUsage).toHaveBeenCalledOnce();
  });

  it('does not attempt a refund when getResult fails and no reservation was ever made', async () => {
    const refundUsage = vi.fn();
    const getResult = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      withReservedUsage({ refundUsage }, false, getResult, undefined, vi.fn()),
    ).rejects.toThrow('boom');

    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('reports a failing refundUsage via onRefundError instead of throwing or masking the original error', async () => {
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockRejectedValue(new Error('refund boom'));
    const originalError = new Error('call failed');
    const getResult = vi.fn().mockRejectedValue(originalError);
    const onRefundError = vi.fn();

    await expect(
      withReservedUsage({ reserveUsage, refundUsage }, false, getResult, undefined, onRefundError),
    ).rejects.toBe(originalError);

    expect(onRefundError).toHaveBeenCalledWith('[VernLLM] refundUsage failed', expect.any(Error));
  });

  it('classifies as aborted, not quota_exceeded, when the signal aborts while reserveUsage is pending', async () => {
    const controller = new AbortController();
    const reserveUsage = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new Error('reservation rejected after abort');
    });
    const getResult = vi.fn();

    await expect(
      withReservedUsage({ reserveUsage }, false, getResult, controller.signal, vi.fn()),
    ).rejects.toMatchObject({ type: 'aborted' });

    expect(getResult).not.toHaveBeenCalled();
  });

  it('short-circuits with an aborted LLMError before reserveUsage runs at all, when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockResolvedValue(undefined);
    const getResult = vi.fn();

    await expect(
      withReservedUsage(
        { reserveUsage, refundUsage },
        false,
        getResult,
        controller.signal,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ type: 'aborted' });

    expect(reserveUsage).not.toHaveBeenCalled();
    expect(getResult).not.toHaveBeenCalled();
    expect(refundUsage).not.toHaveBeenCalled();
  });

  it('refunds and reports aborted when the signal fires while getResult is in flight', async () => {
    const controller = new AbortController();
    const reserveUsage = vi.fn().mockResolvedValue(undefined);
    const refundUsage = vi.fn().mockResolvedValue(undefined);
    const getResult = vi.fn().mockImplementation(async () => {
      controller.abort();
      return 'late value';
    });

    await expect(
      withReservedUsage(
        { reserveUsage, refundUsage },
        false,
        getResult,
        controller.signal,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ type: 'aborted' });

    expect(refundUsage).toHaveBeenCalledOnce();
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
