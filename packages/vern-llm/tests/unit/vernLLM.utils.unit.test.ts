import { describe, it, expect, vi } from 'vitest';

import {
  extractRetryAfterMs,
  normalizeError,
  withReservedUsage,
} from '../../src/internal/vernLLM.utils.js';
import { LLMError } from '../../src/types/errors.js';

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

  it('wraps an error carrying an http status as type "api" and preserves the status', () => {
    const result = normalizeError({ status: 500 });

    expect(result.type).toBe('api');
    expect(result.status).toBe(500);
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

  it('short-circuits with an aborted LLMError, and refunds, when the signal is already aborted before getResult runs', async () => {
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

    expect(getResult).not.toHaveBeenCalled();
    expect(refundUsage).toHaveBeenCalledOnce();
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
