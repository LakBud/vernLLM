import { describe, it, expect, vi } from 'vitest';

import {
  extractRetryAfterMs,
  withTimeout,
  withChunkIdleTimeout,
} from '../../../../src/internal/execution/retry.utils.js';

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

  it('caps an oversized retry-after-ms value at maxDelayMs', () => {
    const err = { headers: headersOf({ 'retry-after-ms': '999999' }) };
    expect(extractRetryAfterMs(err, 10_000)).toBe(10_000);
  });

  it('treats a negative retry-after-ms value as absent instead of 0', () => {
    const err = { headers: headersOf({ 'retry-after-ms': '-100' }) };
    expect(extractRetryAfterMs(err)).toBeUndefined();
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
