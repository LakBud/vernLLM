import { describe, it, expect } from 'vitest';

import { extractRetryAfterMs } from '../../src/internal/vernLLM.utils.js';

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
