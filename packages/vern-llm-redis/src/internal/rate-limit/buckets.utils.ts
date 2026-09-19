export interface Bucket {
  reason: 'concurrency' | 'rpm' | 'tpm';
  key: string;
  initialCapacity: number;
  /** 'permin' refills on a clock (requests/min, tokens/min). 'lease' is the concurrency bucket, held as expiring leases that only an explicit release (or a lapsed lease) frees. */
  rateMode: 'permin' | 'lease';
}

export interface BuildBucketsOptions {
  keyPrefix: string;
  maxConcurrent?: number;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
}

export interface BuiltBuckets {
  buckets: Bucket[];
  /** The requests/min bucket specifically, or undefined if not configured. AIMD only ever resizes this one. */
  rpmBucket: Bucket | undefined;
}

/** Builds the (up to three) buckets a RedisRateLimitOptions config asks for, in a fixed order: concurrency, then requests/min, then tokens/min. */
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
    rpmBucket = {
      reason: 'rpm',
      key: `${options.keyPrefix}:rpm`,
      initialCapacity: options.requestsPerMinute,
      rateMode: 'permin',
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

/** How much of a bucket's capacity one call consumes: estimated tokens for tpm, one unit for everything else. */
export function amountFor(bucket: Bucket, estimatedTokens: number): number {
  return bucket.reason === 'tpm' ? estimatedTokens : 1;
}
