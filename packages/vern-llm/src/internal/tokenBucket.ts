/**
 * A continuously refilling capacity. Per minute buckets refill at `capacity / 60000` per ms; a
 * concurrency bucket refills only through `give`. Mutable so AIMD can `resize()` it.
 */
export class TokenBucket {
  private available: number;
  private lastRefill = Date.now();

  constructor(
    private capacity: number,
    private refillPerMs: number,
  ) {
    this.available = capacity;
  }

  private refill(): void {
    if (this.refillPerMs === 0) return;

    const now = Date.now();
    const elapsedMs = now - this.lastRefill;

    // A backward clock jump counts as no time passing, so it never shrinks `available`.
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
   * Ms until `amount` is available, assuming nothing else takes from it. 0 if it already is,
   * `Infinity` for a bucket that only refills through `give`.
   */
  msUntilAvailable(amount: number): number {
    this.refill();

    if (this.available >= amount) return 0;
    if (this.refillPerMs === 0) return Infinity;

    return (amount - this.available) / this.refillPerMs;
  }

  /**
   * Returns capacity, capped at `capacity`. Not floored at 0: a bad estimate can push it negative,
   * and refill corrects that.
   */
  give(amount: number): void {
    this.available = Math.min(this.capacity, this.available + amount);
  }

  /** The bucket's ceiling, e.g. so a request that could never fit can fail fast instead of queueing forever. */
  getCapacity(): number {
    return this.capacity;
  }

  /** Refills, then reports how much capacity is available right now. */
  getAvailable(): number {
    this.refill();
    return this.available;
  }

  /**
   * Changes capacity in place, clamping `available` on a shrink and rescaling the refill rate by
   * the same ratio.
   */
  resize(newCapacity: number): void {
    this.refill();

    if (this.refillPerMs > 0) {
      this.refillPerMs = (this.refillPerMs / this.capacity) * newCapacity;
    }

    this.capacity = newCapacity;
    this.available = Math.min(this.available, newCapacity);
  }
}
