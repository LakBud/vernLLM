/**
 * Fixed number of coarse time buckets, not one entry per call, the same
 * bounded memory tradeoff `TokenBucket` makes by tracking a running
 * number instead of full history. Lazily rotated on access, no timer,
 * same style as `TokenBucket.refill()`.
 */
const BUCKET_COUNT = 10;

/**
 * Tracks a failure ratio over a trailing time window with bounded
 * memory. Shared by `RollingTripping` (circuitBreaker.ts) and
 * `RetryBudget`, the same way `TokenBucket` is written once and reused
 * by every bucket inside `RateLimiter`.
 */
export class RollingRatio {
  private buckets: { total: number; failures: number }[];
  private bucketStartMs = Date.now();
  private readonly bucketWidthMs: number;

  constructor(windowMs: number) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError(`RollingRatio: windowMs must be a finite number > 0, got ${windowMs}`);
    }

    this.bucketWidthMs = windowMs / BUCKET_COUNT;
    this.buckets = Array.from({ length: BUCKET_COUNT }, () => ({ total: 0, failures: 0 }));
  }

  /** Drops buckets that have aged out of the window, replacing them with fresh, empty ones. */
  private rotate(): void {
    const elapsed = Date.now() - this.bucketStartMs;
    const drop = Math.floor(elapsed / this.bucketWidthMs);
    const shiftCount = Math.min(BUCKET_COUNT, drop);

    for (let i = 0; i < shiftCount; i++) {
      this.buckets.shift();
      this.buckets.push({ total: 0, failures: 0 });
    }

    if (drop > 0) this.bucketStartMs += drop * this.bucketWidthMs;
  }

  /** Records one call outcome into the current bucket. */
  record(failed: boolean): void {
    this.rotate();
    const head = this.buckets[BUCKET_COUNT - 1]!;
    head.total += 1;
    if (failed) head.failures += 1;
  }

  /** Fraction of recorded calls that failed within the window. 0 if nothing has been recorded yet. */
  getRatio(): number {
    this.rotate();
    const t = this.buckets.reduce((a, b) => a + b.total, 0);
    const f = this.buckets.reduce((a, b) => a + b.failures, 0);
    return t === 0 ? 0 : f / t;
  }

  /** Total calls recorded within the window. */
  getCount(): number {
    this.rotate();
    return this.buckets.reduce((a, b) => a + b.total, 0);
  }

  /** Clears every bucket and restarts the window from now. */
  reset(): void {
    this.buckets = Array.from({ length: BUCKET_COUNT }, () => ({ total: 0, failures: 0 }));
    this.bucketStartMs = Date.now();
  }
}
