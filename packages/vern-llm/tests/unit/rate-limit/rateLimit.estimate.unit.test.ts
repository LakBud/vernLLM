import { describe, expect, it, vi } from 'vitest';

import { defaultEstimateTokens, RateLimiter, type WireRequest } from '../../../src/rateLimit.js';

function request(overrides: Partial<WireRequest> = {}): WireRequest {
  return {
    model: 'test-model',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

describe('defaultEstimateTokens', () => {
  it('estimates chars/4 over message content plus max_tokens', () => {
    // 'hello' is 5 chars -> ceil(5/4) = 2, plus max_tokens 100
    expect(defaultEstimateTokens(request())).toBe(102);
  });

  it('stringifies non-string content blocks instead of throwing', () => {
    const req = request({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] as never }],
    });
    expect(() => defaultEstimateTokens(req)).not.toThrow();
    expect(defaultEstimateTokens(req)).toBeGreaterThan(100);
  });

  it('falls back to 0 chars for a message whose content contains a circular reference', () => {
    const circular: Record<string, unknown> = { text: 'hi' };
    circular.self = circular; // JSON.stringify throws on this

    const req = request({ messages: [{ role: 'user', content: circular as never }] });

    // The circular message contributes 0 chars (caught, not thrown),
    // so the estimate is just max_tokens.
    expect(() => defaultEstimateTokens(req)).not.toThrow();
    expect(defaultEstimateTokens(req)).toBe(100);
  });

  it('treats null content the same as undefined content (0 chars)', () => {
    const req = request({ messages: [{ role: 'user', content: null as never }] });

    expect(defaultEstimateTokens(req)).toBe(100);
  });

  it('counts an image as a flat estimate instead of reading its base64 as text', () => {
    // About 750KB of base64, which chars/4 alone would read as ~187k tokens.
    const data = 'A'.repeat(750_000);
    const req = request({
      max_tokens: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image', data, mimeType: 'image/png' },
          ],
        },
      ],
    });

    // 'describe this' is 13 chars -> ceil(13/4) = 4, plus one image at 1600.
    expect(defaultEstimateTokens(req)).toBe(4 + 1_600);
  });

  it('measures a non-array, non-string content value by its JSON length', () => {
    const req = request({
      max_tokens: 0,
      messages: [{ role: 'user', content: { note: 'hi' } as never }],
    });

    // '{"note":"hi"}' is 13 chars -> ceil(13/4) = 4.
    expect(defaultEstimateTokens(req)).toBe(4);
  });

  it('counts an unserializable block as zero chars instead of throwing', () => {
    const circular: Record<string, unknown> = { type: 'custom' };
    circular.self = circular;
    const req = request({
      max_tokens: 0,
      messages: [{ role: 'user', content: [circular, { type: 'text', text: 'abcd' }] as never }],
    });

    expect(defaultEstimateTokens(req)).toBe(1);
  });

  it('counts a block JSON drops entirely (undefined) as zero chars', () => {
    const req = request({
      max_tokens: 0,
      messages: [{ role: 'user', content: [undefined, { type: 'text', text: 'abcd' }] as never }],
    });

    expect(defaultEstimateTokens(req)).toBe(1);
  });

  it('measures a text block whose text is not a string by its JSON length', () => {
    const req = request({
      max_tokens: 0,
      messages: [{ role: 'user', content: [{ type: 'text', text: 42 }] as never }],
    });

    // '{"type":"text","text":42}' is 25 chars -> ceil(25/4) = 7.
    expect(defaultEstimateTokens(req)).toBe(7);
  });

  it('adds the flat estimate once per image across messages', () => {
    const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' };
    const req = request({
      max_tokens: 0,
      messages: [
        { role: 'user', content: [image, image] },
        { role: 'user', content: [image] },
      ],
    });

    expect(defaultEstimateTokens(req)).toBe(3 * 1_600);
  });

  it('lets a large image through a tokensPerMinute limit that its base64 size would exceed', async () => {
    const limiter = new RateLimiter({ tokensPerMinute: 200_000 });
    const req = request({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', data: 'A'.repeat(1_000_000), mimeType: 'image/jpeg' }],
        },
      ],
    });

    const acquired = await limiter.acquire(limiter.estimate(req));
    acquired.release();
  });

  it('defaults max_tokens to 0 when the request omits it', () => {
    const req = request({ max_tokens: undefined });

    // 'hello' is 5 chars -> ceil(5/4) = 2, plus max_tokens 0
    expect(defaultEstimateTokens(req)).toBe(2);
  });
});

describe('RateLimiter, estimateFraction', () => {
  it('defaults to 1, matching pre-estimateFraction behavior', () => {
    const limiter = new RateLimiter({ tokensPerMinute: 1000 });
    expect(limiter.estimate(request())).toBe(defaultEstimateTokens(request()));
  });

  it('scales the estimate down before it is reserved', () => {
    const limiter = new RateLimiter({ tokensPerMinute: 1000, estimateFraction: 0.5 });
    const full = defaultEstimateTokens(request());
    expect(limiter.estimate(request())).toBe(Math.ceil(full * 0.5));
  });

  it('lets two calls fit a bucket that only one would fit at fraction 1', async () => {
    // Full estimate per call is 102 (see defaultEstimateTokens test above),
    // which alone exceeds a 102-token bucket's headroom for a second call.
    // At fraction 0.5 each reserves 51, so two (102 total) fit exactly.
    const limiter = new RateLimiter({ tokensPerMinute: 102, estimateFraction: 0.5, maxQueueMs: 0 });

    const first = await limiter.acquire(limiter.estimate(request()));
    expect(first.waitedMs).toBe(0);
    const second = await limiter.acquire(limiter.estimate(request()));
    expect(second.waitedMs).toBe(0);

    first.release();
    second.release();
  });

  it('reconciles release against the scaled estimate, not the raw one', async () => {
    vi.useFakeTimers();
    // 100 tokens/min bucket, maxQueueSize 0 keeps the queue unbounded so a
    // blocked call waits instead of failing fast, letting us confirm it
    // actually waited rather than misjudging remaining capacity.
    const limiter = new RateLimiter({ tokensPerMinute: 100, estimateFraction: 0.5, maxQueueMs: 0 });

    const scaled = limiter.estimate(request()); // ceil(102 * 0.5) = 51
    const held = await limiter.acquire(scaled);
    held.release(scaled); // actual usage matches the scaled reservation exactly, so no net change

    // Only 51 tokens were actually debited (not the unscaled 102), so 49
    // more must fit immediately.
    const again = await limiter.acquire(49);
    expect(again.waitedMs).toBe(0);
    again.release(49);

    // The bucket is now fully drained (100 taken total); one more token
    // must wait for refill rather than being immediately available.
    let settled = false;
    const pending = limiter.acquire(1).then((r) => {
      settled = true;
      r.release(1);
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(700); // 1 token at 1/600ms
    await pending;
    expect(settled).toBe(true);
  });

  it('never changes the provider-facing max_tokens on the request', () => {
    const limiter = new RateLimiter({ tokensPerMinute: 1000, estimateFraction: 0.5 });
    const req = request({ max_tokens: 500 });
    limiter.estimate(req);
    expect(req.max_tokens).toBe(500);
  });

  it('clamps a value above 1 down to 1 instead of over-reserving', () => {
    const limiter = new RateLimiter({ tokensPerMinute: 1000, estimateFraction: 2 });
    expect(limiter.estimate(request())).toBe(defaultEstimateTokens(request()));
  });

  it('throws at construction when estimateFraction is 0', () => {
    expect(() => new RateLimiter({ tokensPerMinute: 1000, estimateFraction: 0 })).toThrow(
      expect.objectContaining({ type: 'invalid_params' }),
    );
  });

  it('throws at construction when estimateFraction is negative', () => {
    expect(() => new RateLimiter({ tokensPerMinute: 1000, estimateFraction: -0.5 })).toThrow(
      expect.objectContaining({ type: 'invalid_params' }),
    );
  });

  it('throws at construction when estimateFraction is NaN', () => {
    expect(() => new RateLimiter({ tokensPerMinute: 1000, estimateFraction: Number.NaN })).toThrow(
      expect.objectContaining({ type: 'invalid_params' }),
    );
  });

  it('throws at construction when estimateFraction is infinite', () => {
    expect(
      () => new RateLimiter({ tokensPerMinute: 1000, estimateFraction: Number.POSITIVE_INFINITY }),
    ).toThrow(expect.objectContaining({ type: 'invalid_params' }));
  });
});
