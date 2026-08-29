/**
 * A capacity that refills continuously. Used for requests per minute and
 * tokens per minute, where `refillPerMs` is `capacity / 60000`, and for
 * concurrency, where `refillPerMs` is 0 and every release calls
 * `give(1)` instead of relying on the clock.
 */
export class TokenBucket {
  private available: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {
    this.available = capacity;
  }

  private refill(): void {
    if (this.refillPerMs === 0) return;

    const now = Date.now();
    const elapsedMs = now - this.lastRefill;

    // A backward clock adjustment (NTP correction, VM migration, etc.)
    // makes `elapsedMs` negative, which would otherwise reduce `available`
    // on the next line, rate-limiting harder than configured for no
    // real-world reason. Treat a negative elapsed time as no time having
    // passed instead: `available` just doesn't grow this tick, rather
    // than shrinking, and `lastRefill` still advances so a subsequent
    // forward-moving `now` measures from here, not from the skewed past.
    this.available = Math.min(
      this.capacity,
      this.available + Math.max(0, elapsedMs) * this.refillPerMs,
    );
    this.lastRefill = now;
  }

  /** Refills, then takes `amount` if available. Leaves the bucket untouched if it can't. */
  tryTake(amount: number): boolean {
    this.refill();

    if (this.available < amount) return false;

    this.available -= amount;
    return true;
  }

  /**
   * Refills, then reports how many ms until this bucket could supply
   * `amount`, assuming nothing else takes from it meanwhile. Returns 0 if
   * it already can, `Infinity` if it never will on its own (a
   * concurrency bucket, `refillPerMs === 0`, only frees via `give`).
   */
  msUntilAvailable(amount: number): number {
    this.refill();

    if (this.available >= amount) return 0;
    if (this.refillPerMs === 0) return Infinity;

    return (amount - this.available) / this.refillPerMs;
  }

  /**
   * Gives capacity back. Not floored at 0: a bad token-usage estimate can
   * push `available` negative, and it self-corrects on the next refill
   * rather than being clamped away immediately. Only ceilinged at
   * `capacity`, so a give can never overfill the bucket.
   */
  give(amount: number): void {
    this.available = Math.min(this.capacity, this.available + amount);
  }

  /** The bucket's ceiling, e.g. so a request that could never fit can fail fast instead of queueing forever. */
  getCapacity(): number {
    return this.capacity;
  }
}
