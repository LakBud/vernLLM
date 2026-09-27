import { describe, expect, it } from 'vitest';

import {
  extractRetryAfterMs,
  validateMaxRetryAfterMs,
} from '../../../../../../src/internal/execution/utils/retry/retry.utils.js';
import { headersOf } from './retry.helpers.js';

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

  it('ignores a matching plain-object header whose value is not a string, instead of throwing', () => {
    const err = { response: { headers: { 'retry-after-ms': 600 } } };
    expect(() => extractRetryAfterMs(err)).not.toThrow();
    expect(extractRetryAfterMs(err)).toBeUndefined();
  });

  it('caps an oversized retry-after-ms value at maxDelayMs', () => {
    const err = { headers: headersOf({ 'retry-after-ms': '999999' }) };
    expect(extractRetryAfterMs(err, 10_000)).toBe(10_000);
  });

  it('honors a cap above the default, a cap of 0, and no cap at all', () => {
    const err = { headers: headersOf({ 'retry-after': '30' }) };
    expect(extractRetryAfterMs(err, 60_000)).toBe(30_000);
    expect(extractRetryAfterMs(err, 0)).toBe(0);
    expect(extractRetryAfterMs(err, Infinity)).toBe(30_000);
  });

  it('treats a negative retry-after-ms value as absent instead of 0', () => {
    const err = { headers: headersOf({ 'retry-after-ms': '-100' }) };
    expect(extractRetryAfterMs(err)).toBeUndefined();
  });
});

describe('validateMaxRetryAfterMs', () => {
  it('keeps 0, a positive value, and Infinity', () => {
    expect(validateMaxRetryAfterMs(0, 'primary')).toBe(0);
    expect(validateMaxRetryAfterMs(60_000, 'primary')).toBe(60_000);
    expect(validateMaxRetryAfterMs(Infinity, 'primary')).toBe(Infinity);
  });

  it.each([-1, NaN, '5000' as unknown as number])('throws for %s, naming the target', (value) => {
    expect(() => validateMaxRetryAfterMs(value, 'fallback[0]')).toThrow(
      /^fallback\[0\]: maxRetryAfterMs must be 0 or more/,
    );
  });
});
