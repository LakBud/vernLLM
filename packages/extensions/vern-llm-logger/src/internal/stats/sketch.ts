// A log bucketed quantile sketch in the style of DDSketch. Pure numbers, no imports.

const ALPHA = 0.01;
const GAMMA = (1 + ALPHA) / (1 - ALPHA);
const LN_GAMMA = Math.log(GAMMA);
/** Values at or below this share one bucket, which keeps `ln` away from zero. */
const ZERO_BOUND = 0.001;
/** About 700 buckets cover 1 ms to 1,000 s, so this is only a memory bound. */
const MAX_BUCKETS = 2048;
const INITIAL_BUCKETS = 16;

/** Relative error of every quantile estimate. */
export const SKETCH_RELATIVE_ERROR = ALPHA;

export class Sketch {
  private counts = new Float64Array(INITIAL_BUCKETS);
  /** Bucket index held by `counts[0]`. */
  private offset = 0;
  /** Number of `counts` slots in use, from `offset`. */
  private span = 0;
  private zeroCount = 0;
  count = 0;
  sum = 0;
  min = Infinity;
  max = -Infinity;

  /** Ignores anything that is not a finite, non negative number. */
  add(value: number, weight = 1): void {
    if (!Number.isFinite(value) || value < 0 || weight <= 0) return;

    this.count += weight;
    this.sum += value * weight;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;

    if (value <= ZERO_BOUND) {
      this.zeroCount += weight;
      return;
    }
    this.addToBucket(Math.ceil(Math.log(value) / LN_GAMMA), weight);
  }

  /** The value at `q` in [0, 1], or `undefined` when empty. */
  quantile(q: number): number | undefined {
    if (this.count === 0 || !(q >= 0 && q <= 1)) return undefined;

    const rank = q * (this.count - 1);
    let running = this.zeroCount;
    if (running > rank) return 0;

    for (let i = 0; i < this.span; i++) {
      running += this.counts[i] as number;
      if (running > rank) {
        const estimate = (2 * GAMMA ** (this.offset + i)) / (GAMMA + 1);
        return Math.min(this.max, Math.max(this.min, estimate));
      }
    }
    // Counts are whole numbers, so the loop always passes `rank` before it ends.
    /* v8 ignore next */
    return this.max;
  }

  merge(other: Sketch): void {
    if (other.count === 0) return;

    this.count += other.count;
    this.sum += other.sum;
    this.min = Math.min(this.min, other.min);
    this.max = Math.max(this.max, other.max);
    this.zeroCount += other.zeroCount;

    for (let i = 0; i < other.span; i++) {
      const weight = other.counts[i] as number;
      if (weight > 0) this.addToBucket(other.offset + i, weight);
    }
  }

  clear(): void {
    this.counts.fill(0);
    this.offset = 0;
    this.span = 0;
    this.zeroCount = 0;
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }

  private addToBucket(index: number, weight: number): void {
    if (this.span === 0) {
      this.offset = index;
      this.span = 1;
    } else if (index < this.offset) {
      // Below the range: grow downwards, or fold into the lowest bucket once at the bound.
      const needed = this.offset + this.span - index;
      if (needed > MAX_BUCKETS) index = this.offset + this.span - MAX_BUCKETS;
      if (index < this.offset) this.shiftDown(index);
      else index = this.offset;
    } else if (index >= this.offset + this.span) {
      const needed = index - this.offset + 1;
      if (needed > MAX_BUCKETS) this.collapseLowest(index - MAX_BUCKETS + 1);
      this.span = index - this.offset + 1;
    }

    this.ensureCapacity(this.span);
    this.counts[index - this.offset] = (this.counts[index - this.offset] as number) + weight;
  }

  private shiftDown(newOffset: number): void {
    const grow = this.offset - newOffset;
    const next = new Float64Array(Math.max(this.counts.length, this.span + grow));
    next.set(this.counts.subarray(0, this.span), grow);
    this.counts = next;
    this.offset = newOffset;
    this.span += grow;
  }

  /** Folds every bucket below `newOffset` into the one at `newOffset`, the lowest kept. */
  private collapseLowest(newOffset: number): void {
    const drop = Math.min(newOffset - this.offset, this.span);
    let folded = 0;
    for (let i = 0; i < drop; i++) folded += this.counts[i] as number;

    this.counts.copyWithin(0, drop, this.span);
    this.counts.fill(0, this.span - drop, this.span);
    this.span -= drop;
    this.offset = newOffset;
    if (this.span === 0) this.span = 1;
    this.counts[0] = (this.counts[0] as number) + folded;
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.counts.length) return;
    const next = new Float64Array(Math.min(MAX_BUCKETS, Math.max(needed, this.counts.length * 2)));
    next.set(this.counts);
    this.counts = next;
  }
}
