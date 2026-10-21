import { describe, expect, it } from 'vitest';

import { ttlToPx } from '../../../src/internal/ttl.utils.js';

describe('ttlToPx', () => {
  it('converts seconds to milliseconds', () => {
    expect(ttlToPx(30)).toBe(30_000);
  });

  it('rounds a sub millisecond TTL up to 1 rather than 0', () => {
    expect(ttlToPx(0.0001)).toBe(1);
  });

  it('rounds fractional milliseconds up', () => {
    expect(ttlToPx(1.0005)).toBe(1001);
  });

  it('caps Infinity and absurd values at what Redis can add to the current time', () => {
    expect(ttlToPx(Infinity)).toBe(Number.MAX_SAFE_INTEGER);
    expect(ttlToPx(Number.MAX_VALUE)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([0, -1, -Infinity, Number.NaN, undefined, null, '5', {}])(
    'treats %s as already expired',
    (ttl) => {
      expect(ttlToPx(ttl)).toBeUndefined();
    },
  );
});
