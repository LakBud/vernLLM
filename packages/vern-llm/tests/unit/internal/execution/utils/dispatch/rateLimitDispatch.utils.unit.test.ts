import { describe, expect, it, vi } from 'vitest';

import { acquireRateLimit } from '../../../../../../src/internal/execution/utils/dispatch/rateLimitDispatch.utils.js';

import type { RateLimiter, WireRequest } from '../../../../../../src/rateLimit.js';

const request: WireRequest = {
  model: 'test-model',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hello' }],
};

/** A `RateLimiter`-shaped fake, so `acquireRateLimit`'s dispatch logic is tested without exercising the real queueing behavior (already covered by `rateLimit.unit.test.ts`). */
function fakeLimiter(acquireResult: {
  release: (actualTokens?: number) => void;
  waitedMs: number;
  reason?: 'concurrency' | 'rpm' | 'tpm';
}): RateLimiter {
  return {
    estimate: vi.fn(() => 42),
    acquire: vi.fn(async () => acquireResult),
  } as unknown as RateLimiter;
}

describe('acquireRateLimit', () => {
  it('is a no-op, returning no release, when no limiter is configured', async () => {
    const onRateLimited = vi.fn();

    const result = await acquireRateLimit(undefined, request, undefined, onRateLimited);

    expect(result).toEqual({});
    expect(onRateLimited).not.toHaveBeenCalled();
  });

  it('does not report rate_limited when the acquire did not wait', async () => {
    const release = vi.fn();
    const limiter = fakeLimiter({ release, waitedMs: 0 });
    const onRateLimited = vi.fn();

    const result = await acquireRateLimit(limiter, request, undefined, onRateLimited);

    expect(onRateLimited).not.toHaveBeenCalled();
    expect(result.release).toBe(release);
  });

  it('reports rate_limited with the waited time and reason when the acquire had to wait', async () => {
    const release = vi.fn();
    const limiter = fakeLimiter({ release, waitedMs: 250, reason: 'tpm' });
    const onRateLimited = vi.fn();

    await acquireRateLimit(limiter, request, undefined, onRateLimited);

    expect(onRateLimited).toHaveBeenCalledExactlyOnceWith(250, 'tpm');
  });

  it('defaults the reported reason to rpm when the acquire waited but reported none', async () => {
    const limiter = fakeLimiter({ release: vi.fn(), waitedMs: 100, reason: undefined });
    const onRateLimited = vi.fn();

    await acquireRateLimit(limiter, request, undefined, onRateLimited);

    expect(onRateLimited).toHaveBeenCalledExactlyOnceWith(100, 'rpm');
  });

  it('hands back the release the limiter returned, unwrapped', async () => {
    const release = vi.fn();
    const limiter = fakeLimiter({ release, waitedMs: 0 });

    const result = await acquireRateLimit(limiter, request, undefined, vi.fn());

    expect(result.release).toBe(release);
    result.release?.(123);
    expect(release).toHaveBeenCalledExactlyOnceWith(123);
  });

  it('estimates tokens for the given request and forwards the signal to acquire', async () => {
    const controller = new AbortController();
    const limiter = fakeLimiter({ release: vi.fn(), waitedMs: 0 });

    await acquireRateLimit(limiter, request, controller.signal, vi.fn());

    expect(limiter.estimate).toHaveBeenCalledExactlyOnceWith(request);
    expect(limiter.acquire).toHaveBeenCalledExactlyOnceWith(42, controller.signal);
  });
});
