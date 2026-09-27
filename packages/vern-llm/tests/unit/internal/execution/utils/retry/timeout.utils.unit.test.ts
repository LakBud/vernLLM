import { describe, expect, it, vi } from 'vitest';

import {
  withChunkIdleTimeout,
  withTimeout,
} from '../../../../../../src/internal/execution/utils/retry/retry.utils.js';

/** Mirrors the internal MAX_SETTIMEOUT_MS constant, setTimeout's real ceiling (~24.8 days). */
const MAX_SETTIMEOUT_MS = 2_147_483_647;

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
