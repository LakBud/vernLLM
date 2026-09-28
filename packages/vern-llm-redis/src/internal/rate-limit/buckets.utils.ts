export interface Bucket {
  reason: 'concurrency' | 'rpm' | 'tpm';
  key: string;
  initialCapacity: number;
  /** 'permin' refills per minute. 'lease' is concurrency, held as expiring leases. */
  rateMode: 'permin' | 'lease';
  /** The AIMD ceiling key, rpm bucket only. Never expires, same cluster slot as the bucket. */
  capKey?: string;
}

export interface BuildBucketsOptions {
  keyPrefix: string;
  maxConcurrent?: number;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  /** Set when AIMD resizes the rpm bucket. Its start is clamped to maxCapacity. */
  aimd?: { maxCapacity: number };
}

export interface BuiltBuckets {
  buckets: Bucket[];
  /** The requests per minute bucket, the one AIMD resizes. */
  rpmBucket: Bucket | undefined;
}

/** The buckets asked for, in order: concurrency, requests, tokens. */
export function buildBuckets(options: BuildBucketsOptions): BuiltBuckets {
  const buckets: Bucket[] = [];
  let rpmBucket: Bucket | undefined;

  if (options.maxConcurrent) {
    buckets.push({
      reason: 'concurrency',
      key: `${options.keyPrefix}:concurrency`,
      initialCapacity: options.maxConcurrent,
      rateMode: 'lease',
    });
  }

  if (options.requestsPerMinute) {
    const key = `${options.keyPrefix}:rpm`;
    rpmBucket = {
      reason: 'rpm',
      key,
      initialCapacity: options.aimd
        ? Math.min(options.requestsPerMinute, options.aimd.maxCapacity)
        : options.requestsPerMinute,
      rateMode: 'permin',
      ...(options.aimd ? { capKey: sameSlotKey(key, ':aimd') } : {}),
    };
    buckets.push(rpmBucket);
  }

  if (options.tokensPerMinute) {
    buckets.push({
      reason: 'tpm',
      key: `${options.keyPrefix}:tpm`,
      initialCapacity: options.tokensPerMinute,
      rateMode: 'permin',
    });
  }

  return { buckets, rpmBucket };
}

/** One call's share: estimated tokens for tpm, else 1. */
export function amountFor(bucket: Bucket, estimatedTokens: number): number {
  return bucket.reason === 'tpm' ? estimatedTokens : 1;
}

/** A script's keys for `bucket`: the bucket, then its ceiling key if any. */
export function keysFor(bucket: Bucket): string[] {
  return bucket.capKey ? [bucket.key, bucket.capKey] : [bucket.key];
}

/** Redis Cluster's hash tag, if the key has one. */
function hashTag(key: string): string | undefined {
  const open = key.indexOf('{');
  if (open === -1) return undefined;

  const close = key.indexOf('}', open + 1);
  return close > open + 1 ? key.slice(open + 1, close) : undefined;
}

/** A key in the same cluster slot as `key`. With a stray `}` and no tag it can't be, and a cluster rejects the pair. */
export function sameSlotKey(key: string, suffix: string): string {
  if (hashTag(key) !== undefined || key.includes('}')) return `${key}${suffix}`;
  return `{${key}}${suffix}`;
}
