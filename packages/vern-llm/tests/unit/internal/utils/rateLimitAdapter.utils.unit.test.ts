import { describe, expect, it } from 'vitest';

import { buildRateLimit } from '../../../../src/internal/utils/rateLimitAdapter.utils.js';
import { RateLimiter, type RateLimiterAdapter } from '../../../../src/rateLimit.js';
import { LLMError } from '../../../../src/types/errors.js';

describe('buildRateLimit', () => {
  it('returns undefined when option is omitted, no default limiter created', () => {
    expect(buildRateLimit(undefined)).toBeUndefined();
  });

  it('builds a real RateLimiter from a plain RateLimitOptions object', () => {
    const limiter = buildRateLimit({ requestsPerMinute: 10 });

    expect(limiter).toBeInstanceOf(RateLimiter);
  });

  it('passes a hand built RateLimiterAdapter through untouched, never re-wrapping it', () => {
    const custom: RateLimiterAdapter = {
      estimate: () => 0,
      acquire: async () => ({ release: () => {}, waitedMs: 0 }),
      signalRateLimit: () => {},
      reactToRateLimitHint: () => {},
    };

    expect(buildRateLimit(custom)).toBe(custom);
  });

  it('passes a plain RateLimiter instance through as-is, not reconstructing it', () => {
    const custom = new RateLimiter({ requestsPerMinute: 5 });

    expect(buildRateLimit(custom)).toBe(custom);
  });

  it('treats an object missing acquire/estimate as config, not a limiter', () => {
    // Not a RateLimiterAdapter (no acquire/estimate), so this is routed
    // through the RateLimitOptions branch and constructs normally.
    const limiter = buildRateLimit({ maxConcurrent: 2 });

    expect(limiter).toBeInstanceOf(RateLimiter);
  });

  describe('an incomplete adapter (some but not all four methods present)', () => {
    const fullAdapter = {
      estimate: () => 0,
      acquire: async () => ({ release: () => {}, waitedMs: 0 }),
      signalRateLimit: () => {},
      reactToRateLimitHint: () => {},
    };

    for (const missing of [
      'estimate',
      'acquire',
      'signalRateLimit',
      'reactToRateLimitHint',
    ] as const) {
      it(`throws a clear error when only ${missing} is missing, instead of silently passing it through`, () => {
        const { [missing]: _omitted, ...partial } = fullAdapter;

        expect(() => buildRateLimit(partial as never)).toThrow(
          new RegExp(`missing: ${missing}\\b`),
        );
      });
    }

    it('lists every missing method when several are absent at once', () => {
      const partial = { estimate: () => 0, acquire: fullAdapter.acquire };

      expect(() => buildRateLimit(partial as never)).toThrow(
        /missing: signalRateLimit, reactToRateLimitHint/,
      );
    });
  });

  describe('an adapter with a non-function getState', () => {
    const fullAdapter = {
      estimate: () => 0,
      acquire: async () => ({ release: () => {}, waitedMs: 0 }),
      signalRateLimit: () => {},
      reactToRateLimitHint: () => {},
    };

    it('throws instead of silently accepting getState: {} (a present, non-callable value)', () => {
      const withBadGetState = { ...fullAdapter, getState: {} };

      expect(() => buildRateLimit(withBadGetState as never)).toThrow(
        /getState.*must be a function/,
      );
    });

    it('throws for a non-function getState even when it is the only problem (all four required methods valid)', () => {
      const withBadGetState = { ...fullAdapter, getState: 'not-a-function' };

      expect(() => buildRateLimit(withBadGetState as never)).toThrow(LLMError);
    });

    it('accepts a real adapter when getState is a genuine function', () => {
      const withGoodGetState = { ...fullAdapter, getState: () => ({}) };

      expect(buildRateLimit(withGoodGetState as never)).toBe(withGoodGetState);
    });

    it('accepts a real adapter when getState is omitted entirely', () => {
      expect(buildRateLimit(fullAdapter as never)).toBe(fullAdapter);
    });
  });
});
