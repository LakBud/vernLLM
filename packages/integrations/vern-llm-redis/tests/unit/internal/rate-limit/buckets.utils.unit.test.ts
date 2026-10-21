import { describe, expect, it } from 'vitest';

import {
  amountFor,
  buildBuckets,
  keysFor,
  sameSlotKey,
} from '../../../../src/internal/rate-limit/buckets.utils.js';

describe('buildBuckets', () => {
  it('builds no buckets when nothing is configured', () => {
    const { buckets, rpmBucket } = buildBuckets({ keyPrefix: 'p' });
    expect(buckets).toEqual([]);
    expect(rpmBucket).toBeUndefined();
  });

  it('builds only the buckets that were actually configured', () => {
    const { buckets } = buildBuckets({ keyPrefix: 'p', requestsPerMinute: 10 });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.reason).toBe('rpm');
  });

  it('builds concurrency, then requests/min, then tokens/min, in that fixed order', () => {
    const { buckets } = buildBuckets({
      keyPrefix: 'p',
      maxConcurrent: 5,
      requestsPerMinute: 10,
      tokensPerMinute: 1000,
    });

    expect(buckets.map((b) => b.reason)).toEqual(['concurrency', 'rpm', 'tpm']);
  });

  it('keys each bucket under keyPrefix, suffixed by its own reason', () => {
    const { buckets } = buildBuckets({
      keyPrefix: 'vernllm:rl',
      maxConcurrent: 5,
      requestsPerMinute: 10,
      tokensPerMinute: 1000,
    });

    expect(buckets.map((b) => b.key)).toEqual([
      'vernllm:rl:concurrency',
      'vernllm:rl:rpm',
      'vernllm:rl:tpm',
    ]);
  });

  it("carries each option straight through as the bucket's initialCapacity", () => {
    const { buckets } = buildBuckets({
      keyPrefix: 'p',
      maxConcurrent: 5,
      requestsPerMinute: 10,
      tokensPerMinute: 1000,
    });

    expect(buckets.map((b) => b.initialCapacity)).toEqual([5, 10, 1000]);
  });

  it('gives the concurrency bucket rateMode "lease", held as expiring leases with no time based refill', () => {
    const { buckets } = buildBuckets({ keyPrefix: 'p', maxConcurrent: 1 });
    expect(buckets[0]?.rateMode).toBe('lease');
  });

  it('gives requests/min and tokens/min buckets rateMode "permin"', () => {
    const { buckets } = buildBuckets({
      keyPrefix: 'p',
      requestsPerMinute: 10,
      tokensPerMinute: 1000,
    });
    expect(buckets.every((b) => b.rateMode === 'permin')).toBe(true);
  });

  it('returns the requests/min bucket specifically as rpmBucket, the only one AIMD ever resizes', () => {
    const { rpmBucket } = buildBuckets({ keyPrefix: 'p', requestsPerMinute: 10 });
    expect(rpmBucket?.reason).toBe('rpm');
  });

  it('rpmBucket is undefined when requestsPerMinute was not configured, even with other buckets present', () => {
    const { rpmBucket } = buildBuckets({ keyPrefix: 'p', maxConcurrent: 5, tokensPerMinute: 1000 });
    expect(rpmBucket).toBeUndefined();
  });

  it('treats a zero value as "not configured", the same as omitting the option entirely', () => {
    const { buckets } = buildBuckets({ keyPrefix: 'p', maxConcurrent: 0, requestsPerMinute: 0 });
    expect(buckets).toEqual([]);
  });
});

describe('amountFor', () => {
  it('charges the full estimated tokens against a tokens/min bucket', () => {
    const bucket = {
      reason: 'tpm' as const,
      key: 'k',
      initialCapacity: 100,
      rateMode: 'permin' as const,
    };
    expect(amountFor(bucket, 42)).toBe(42);
  });

  it('charges exactly one unit against a requests/min bucket, regardless of estimated tokens', () => {
    const bucket = {
      reason: 'rpm' as const,
      key: 'k',
      initialCapacity: 10,
      rateMode: 'permin' as const,
    };
    expect(amountFor(bucket, 999)).toBe(1);
  });

  it('charges exactly one unit against a concurrency bucket, regardless of estimated tokens', () => {
    const bucket = {
      reason: 'concurrency' as const,
      key: 'k',
      initialCapacity: 1,
      rateMode: 'lease' as const,
    };
    expect(amountFor(bucket, 999)).toBe(1);
  });
});

describe('the AIMD ceiling key', () => {
  it('is set only on the requests/min bucket, and only with aimd', () => {
    const plain = buildBuckets({ keyPrefix: 'p', requestsPerMinute: 10, tokensPerMinute: 100 });
    const withAimd = buildBuckets({
      keyPrefix: 'p',
      requestsPerMinute: 10,
      tokensPerMinute: 100,
      aimd: { maxCapacity: 50 },
    });

    expect(plain.buckets.every((b) => b.capKey === undefined)).toBe(true);
    expect(withAimd.rpmBucket?.capKey).toBe('{p:rpm}:aimd');
    expect(withAimd.buckets.find((b) => b.reason === 'tpm')?.capKey).toBeUndefined();
  });

  it('clamps the starting ceiling to maxCapacity', () => {
    expect(
      buildBuckets({ keyPrefix: 'p', requestsPerMinute: 80, aimd: { maxCapacity: 50 } }).rpmBucket
        ?.initialCapacity,
    ).toBe(50);
    expect(
      buildBuckets({ keyPrefix: 'p', requestsPerMinute: 30, aimd: { maxCapacity: 50 } }).rpmBucket
        ?.initialCapacity,
    ).toBe(30);
  });

  it('keysFor lists the bucket, then its ceiling key when it has one', () => {
    const { buckets } = buildBuckets({
      keyPrefix: 'p',
      maxConcurrent: 1,
      requestsPerMinute: 10,
      aimd: { maxCapacity: 50 },
    });

    expect(buckets.map(keysFor)).toEqual([['p:concurrency'], ['p:rpm', '{p:rpm}:aimd']]);
  });
});

describe('sameSlotKey', () => {
  it('wraps an untagged key so the whole key becomes the hash tag', () => {
    expect(sameSlotKey('vernllm:rl:rpm', ':aimd')).toBe('{vernllm:rl:rpm}:aimd');
  });

  it('keeps a key that already has a hash tag as is', () => {
    expect(sameSlotKey('{app}:rl:rpm', ':aimd')).toBe('{app}:rl:rpm:aimd');
  });

  it('wraps a key whose braces are not a tag, when that keeps the same text hashed', () => {
    expect(sameSlotKey('a{b', ':x')).toBe('{a{b}:x');
  });

  it('falls back to a plain suffix for a stray closing brace', () => {
    expect(sameSlotKey('a{}b', ':x')).toBe('a{}b:x');
    expect(sameSlotKey('a}b', ':x')).toBe('a}b:x');
  });
});
