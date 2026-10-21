import { describe, expect, it } from 'vitest';

import {
  parseWindowReply,
  READ_SCRIPT,
  RECORD_SCRIPT,
} from '../../../../src/internal/retry-budget/scripts.js';

describe('retry budget scripts', () => {
  it('both read time from Redis, never the caller', () => {
    expect(RECORD_SCRIPT).toContain("redis.call('TIME')");
    expect(READ_SCRIPT).toContain("redis.call('TIME')");
  });

  it('only the record script counts an attempt or extends the key', () => {
    expect(RECORD_SCRIPT).toContain('HINCRBY');
    expect(RECORD_SCRIPT).toContain('PEXPIRE');
    expect(READ_SCRIPT).not.toContain('HINCRBY');
    expect(READ_SCRIPT).not.toContain('PEXPIRE');
  });
});

describe('parseWindowReply', () => {
  it('reads numbers and numeric strings', () => {
    expect(parseWindowReply([5, 2])).toEqual({ attempts: 5, retries: 2 });
    expect(parseWindowReply(['5', '2'])).toEqual({ attempts: 5, retries: 2 });
    expect(parseWindowReply([0, 0])).toEqual({ attempts: 0, retries: 0 });
  });

  it.each([
    ['not an array', 'OK'],
    ['too short', [1]],
    ['too long', [1, 1, 1]],
    ['a fraction', [1.5, 0]],
    ['not a number', ['x', 0]],
    ['more retries than attempts', [1, 2]],
    ['null', null],
  ])('throws on %s', (_label, reply) => {
    expect(() => parseWindowReply(reply)).toThrow(
      `Unexpected retry budget script reply: ${JSON.stringify(reply)}`,
    );
  });
});
