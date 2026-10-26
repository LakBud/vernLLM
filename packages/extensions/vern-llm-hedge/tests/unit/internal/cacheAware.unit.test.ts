import { describe, expect, it } from 'vitest';

import { CacheAware } from '../../../src/internal/cacheAware.js';
import { normalizeOptions } from '../../../src/internal/options/normalizeOptions.utils.js';

import type { WireCallRequest } from 'vern-llm';

const config = (extra: Record<string, unknown> = {}) =>
  normalizeOptions({ delay: 100, cacheAware: { prefixChars: 20, ttlMs: 1_000, ...extra } })
    .cacheAware!;
const request = (...contents: unknown[]) =>
  ({
    model: 'm',
    max_tokens: 10,
    messages: contents.map((content) => ({ role: 'user', content })),
  }) as unknown as WireCallRequest;

describe('keyOf', () => {
  const cache = new CacheAware(config());

  it('is the same for requests that start the same way, however they continue', () => {
    expect(cache.keyOf(request('the shared system prompt, then a question'))).toBe(
      cache.keyOf(request('the shared system prompt, then another one')),
    );
  });

  it('differs for requests that start differently', () => {
    expect(cache.keyOf(request('one prompt'))).not.toBe(cache.keyOf(request('another prompt')));
  });

  it('reads text blocks, and skips content that is not text', () => {
    const blocks = [{ type: 'text', text: 'hello' }, { type: 'image' }, null, { text: 5 }];

    expect(cache.keyOf(request(blocks))).toBe(cache.keyOf(request('hello')));
    expect(cache.keyOf(request(undefined))).toBe(cache.keyOf(request(42)));
  });

  it('stops reading messages once the prefix is long enough', () => {
    const long = 'x'.repeat(40);

    expect(cache.keyOf(request(long, 'a'))).toBe(cache.keyOf(request(long, 'b')));
  });
});

describe('warm', () => {
  it('is true for the target that served the prefix, until the ttl passes', () => {
    const cache = new CacheAware(config());
    cache.remember('a', 'k', 1_000);

    expect(cache.warm('a', 'k', 1_000)).toBe(true);
    expect(cache.warm('a', 'k', 1_999)).toBe(true);
    expect(cache.warm('a', 'k', 2_000)).toBe(false);
  });

  it('is false for another target or another prefix, and for a clock that went back', () => {
    const cache = new CacheAware(config());
    cache.remember('a', 'k', 1_000);

    expect(cache.warm('b', 'k', 1_000)).toBe(false);
    expect(cache.warm('a', 'other', 1_000)).toBe(false);
    expect(cache.warm('a', 'k', 500)).toBe(false);
  });

  it('keeps the newest entries when it grows past its cap', () => {
    const cache = new CacheAware(config({ ttlMs: 10 ** 9 }));
    for (let i = 0; i < 10_001; i++) cache.remember('a', String(i), 1);

    expect(cache.size).toBe(10_000);
    expect(cache.warm('a', '0', 1)).toBe(false);
    expect(cache.warm('a', '10000', 1)).toBe(true);
  });

  it('moves a prefix seen again to the newest', () => {
    const cache = new CacheAware(config({ ttlMs: 10 ** 9 }));
    cache.remember('a', 'first', 1);
    for (let i = 0; i < 9_999; i++) cache.remember('a', String(i), 1);
    cache.remember('a', 'first', 2);
    cache.remember('a', 'overflow', 2);

    expect(cache.warm('a', 'first', 2)).toBe(true);
    expect(cache.warm('a', '0', 2)).toBe(false);
  });
});
