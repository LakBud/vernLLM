import { Sketch } from './sketch.js';

/** A ring of slots over a window. A slot from an older period is cleared before reuse. */
export class Ring<T> {
  private readonly items: T[];
  private readonly periods: number[];
  private readonly slotMs: number;

  constructor(
    private readonly slots: number,
    durationMs: number,
    make: () => T,
    private readonly reset: (item: T) => void,
  ) {
    this.slotMs = durationMs / slots;
    this.items = Array.from({ length: slots }, make);
    this.periods = new Array<number>(slots).fill(-Infinity);
  }

  periodAt(now: number): number {
    return Math.floor(now / this.slotMs);
  }

  /** The slot for `now`, cleared first if it still holds an older period. */
  at(now: number): T {
    const period = this.periodAt(now);
    const index = ((period % this.slots) + this.slots) % this.slots;
    if (this.periods[index] !== period) {
      this.reset(this.items[index] as T);
      this.periods[index] = period;
    }
    return this.items[index] as T;
  }

  /** Every slot still inside the window that ends at `now`. */
  live(now: number): T[] {
    const oldest = this.periodAt(now) - this.slots + 1;
    return this.items.filter((_, index) => (this.periods[index] as number) >= oldest);
  }

  clear(): void {
    this.items.forEach((item) => this.reset(item));
    this.periods.fill(-Infinity);
  }
}

interface SketchSlot<Tag> {
  sketch: Sketch;
  /** What produced this slot's largest value, for an exemplar. */
  maxTag: Tag | undefined;
}

/** A window of sketches. Reads merge the live slots into one scratch sketch that is reused. */
export class RollingSketch<Tag = string> {
  private readonly ring: Ring<SketchSlot<Tag>>;
  private readonly scratch = new Sketch();
  private cachedPeriod = -Infinity;
  private cachedValue: number | undefined;

  constructor(
    durationMs: number,
    slots: number,
    private readonly cachedQuantileOf?: number,
  ) {
    this.ring = new Ring<SketchSlot<Tag>>(
      slots,
      durationMs,
      () => ({ sketch: new Sketch(), maxTag: undefined }),
      (slot) => {
        slot.sketch.clear();
        slot.maxTag = undefined;
      },
    );
  }

  add(now: number, value: number, tag?: Tag): void {
    const slot = this.ring.at(now);
    const before = slot.sketch.max;
    slot.sketch.add(value);
    if (tag !== undefined && slot.sketch.max > before) slot.maxTag = tag;
  }

  /** How many samples are in the window. Cheap: sums slot counts, merges nothing. */
  count(now: number): number {
    let total = 0;
    for (const slot of this.ring.live(now)) total += slot.sketch.count;
    return total;
  }

  /** The values at each `q`, or `undefined` when the window is empty. */
  quantiles(now: number, qs: readonly number[]): (number | undefined)[] {
    this.mergeLive(now);
    return qs.map((q) => this.scratch.quantile(q));
  }

  /** Adds the live slots into `target`, for reads that span several series. */
  mergeInto(now: number, target: Sketch): void {
    for (const slot of this.ring.live(now)) target.merge(slot.sketch);
  }

  /** The largest value in the window and the tag that produced it. */
  slowest(now: number): { tag: Tag; value: number } | undefined {
    let best: { tag: Tag; value: number } | undefined;
    for (const slot of this.ring.live(now)) {
      if (slot.maxTag !== undefined && (!best || slot.sketch.max > best.value)) {
        best = { tag: slot.maxTag, value: slot.sketch.max };
      }
    }
    return best;
  }

  /** The configured quantile, recomputed once per slot period. */
  cachedQuantile(now: number): number | undefined {
    if (this.cachedQuantileOf === undefined) return undefined;
    const period = this.ring.periodAt(now);
    if (period !== this.cachedPeriod) {
      this.cachedPeriod = period;
      this.mergeLive(now);
      this.cachedValue = this.scratch.quantile(this.cachedQuantileOf);
    }
    return this.cachedValue;
  }

  clear(): void {
    this.ring.clear();
    this.cachedPeriod = -Infinity;
    this.cachedValue = undefined;
  }

  private mergeLive(now: number): void {
    this.scratch.clear();
    this.mergeInto(now, this.scratch);
  }
}
