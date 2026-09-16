import { describe, expect, it } from 'vitest';

import { parseTakeResult } from '../../../../src/internal/rate-limit/scripts.js';

describe('parseTakeResult', () => {
  it('parses a successful take, ok true and no wait', () => {
    expect(parseTakeResult([1, '9', '10', '-1'])).toEqual({
      ok: true,
      avail: 9,
      cap: 10,
      waitMs: -1,
    });
  });

  it('parses a failed take, ok false and a positive wait', () => {
    expect(parseTakeResult([0, '0', '10', '2500'])).toEqual({
      ok: false,
      avail: 0,
      cap: 10,
      waitMs: 2500,
    });
  });

  it('parses a concurrency bucket\u2019s failed take, waitMs stays -1, no deterministic refill exists', () => {
    expect(parseTakeResult([0, '0', '1', '-1'])).toEqual({
      ok: false,
      avail: 0,
      cap: 1,
      waitMs: -1,
    });
  });

  it('coerces the string-encoded avail and cap fields to numbers', () => {
    const result = parseTakeResult([1, '123.5', '456', '-1']);
    expect(result.avail).toBe(123.5);
    expect(result.cap).toBe(456);
  });
});
