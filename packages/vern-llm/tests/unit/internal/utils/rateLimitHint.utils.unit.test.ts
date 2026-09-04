import { describe, it, expect } from 'vitest';

import {
  attachRateLimitHint,
  parseAnthropicRateLimitHeaders,
  parseAnyRateLimitHeaders,
  parseOpenAIRateLimitHeaders,
  readRateLimitHint,
  type HeaderReader,
} from '../../../../src/internal/utils/rateLimitHint.utils.js';

function headers(values: Record<string, string>): HeaderReader {
  return { get: (name: string) => values[name] ?? null };
}

describe('parseOpenAIRateLimitHeaders', () => {
  it('parses limit/remaining as numbers and reset as a Go-style duration into ms', () => {
    const hint = parseOpenAIRateLimitHeaders(
      headers({
        'x-ratelimit-limit-requests': '500',
        'x-ratelimit-remaining-requests': '499',
        'x-ratelimit-reset-requests': '6m0s',
      }),
    );

    expect(hint.limitRequests).toBe(500);
    expect(hint.remainingRequests).toBe(499);
    expect(hint.resetAfterMs).toBe(6 * 60_000);
  });

  it('parses a bare-seconds duration like "1s"', () => {
    const hint = parseOpenAIRateLimitHeaders(headers({ 'x-ratelimit-reset-requests': '1s' }));
    expect(hint.resetAfterMs).toBe(1_000);
  });

  it('parses an hours-only duration like "2h"', () => {
    const hint = parseOpenAIRateLimitHeaders(headers({ 'x-ratelimit-reset-requests': '2h' }));
    expect(hint.resetAfterMs).toBe(2 * 3_600_000);
  });

  it('parses a milliseconds-only duration like "500ms"', () => {
    const hint = parseOpenAIRateLimitHeaders(headers({ 'x-ratelimit-reset-requests': '500ms' }));
    expect(hint.resetAfterMs).toBe(500);
  });

  it('parses a duration combining every unit, e.g. "1h2m3s4ms"', () => {
    const hint = parseOpenAIRateLimitHeaders(
      headers({ 'x-ratelimit-reset-requests': '1h2m3s4ms' }),
    );
    expect(hint.resetAfterMs).toBe(3_600_000 + 2 * 60_000 + 3_000 + 4);
  });

  it('tolerates surrounding whitespace in the duration string', () => {
    const hint = parseOpenAIRateLimitHeaders(headers({ 'x-ratelimit-reset-requests': '  1s  ' }));
    expect(hint.resetAfterMs).toBe(1_000);
  });

  it('returns undefined resetAfterMs for an unrecognized duration format', () => {
    const hint = parseOpenAIRateLimitHeaders(
      headers({ 'x-ratelimit-reset-requests': 'not-a-duration' }),
    );
    expect(hint.resetAfterMs).toBeUndefined();
  });

  it('returns undefined resetAfterMs for an empty-string duration', () => {
    const hint = parseOpenAIRateLimitHeaders(headers({ 'x-ratelimit-reset-requests': '' }));
    expect(hint.resetAfterMs).toBeUndefined();
  });

  it('returns undefined fields when headers are absent, not throwing', () => {
    const hint = parseOpenAIRateLimitHeaders(headers({}));
    expect(hint.limitRequests).toBeUndefined();
    expect(hint.remainingRequests).toBeUndefined();
    expect(hint.resetAfterMs).toBeUndefined();
  });

  it('treats a non-numeric limit/remaining value as absent rather than NaN', () => {
    const hint = parseOpenAIRateLimitHeaders(
      headers({ 'x-ratelimit-remaining-requests': 'not-a-number' }),
    );
    expect(hint.remainingRequests).toBeUndefined();
  });
});

describe('parseAnthropicRateLimitHeaders', () => {
  it('parses limit/remaining as numbers and reset as an RFC 3339 timestamp into ms-from-now', () => {
    const resetAt = new Date(Date.now() + 45_000).toISOString();
    const hint = parseAnthropicRateLimitHeaders(
      headers({
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '49',
        'anthropic-ratelimit-requests-reset': resetAt,
      }),
    );

    expect(hint.limitRequests).toBe(50);
    expect(hint.remainingRequests).toBe(49);
    expect(hint.resetAfterMs).toBeGreaterThan(40_000);
    expect(hint.resetAfterMs).toBeLessThanOrEqual(45_000);
  });

  it('clamps resetAfterMs to 0 rather than going negative for a reset already in the past', () => {
    const pastReset = new Date(Date.now() - 5_000).toISOString();
    const hint = parseAnthropicRateLimitHeaders(
      headers({ 'anthropic-ratelimit-requests-reset': pastReset }),
    );
    expect(hint.resetAfterMs).toBe(0);
  });

  it('returns undefined fields when headers are absent', () => {
    const hint = parseAnthropicRateLimitHeaders(headers({}));
    expect(hint.limitRequests).toBeUndefined();
    expect(hint.remainingRequests).toBeUndefined();
    expect(hint.resetAfterMs).toBeUndefined();
  });
});

describe('parseAnyRateLimitHeaders', () => {
  it('returns the OpenAI shape when those headers are present', () => {
    const hint = parseAnyRateLimitHeaders(headers({ 'x-ratelimit-remaining-requests': '10' }));
    expect(hint?.remainingRequests).toBe(10);
  });

  it('falls back to the Anthropic shape when OpenAI headers are absent', () => {
    const hint = parseAnyRateLimitHeaders(
      headers({ 'anthropic-ratelimit-requests-remaining': '20' }),
    );
    expect(hint?.remainingRequests).toBe(20);
  });

  it('returns undefined, not an empty object, when neither shape yields anything', () => {
    expect(parseAnyRateLimitHeaders(headers({}))).toBeUndefined();
  });
});

describe('attachRateLimitHint / readRateLimitHint', () => {
  it('round-trips a hint through a plain object without making it enumerable', () => {
    const value = { choices: [] };
    attachRateLimitHint(value, { remainingRequests: 3 });

    expect(readRateLimitHint(value)).toEqual({ remainingRequests: 3 });
    expect(Object.keys(value)).toEqual(['choices']);
    expect(JSON.stringify(value)).toBe('{"choices":[]}');
  });

  it('is a no-op when the hint is undefined', () => {
    const value = {};
    attachRateLimitHint(value, undefined);
    expect(readRateLimitHint(value)).toBeUndefined();
  });

  it('readRateLimitHint returns undefined for a value with nothing attached', () => {
    expect(readRateLimitHint({})).toBeUndefined();
    expect(readRateLimitHint(null)).toBeUndefined();
    expect(readRateLimitHint(42)).toBeUndefined();
  });
});
