import { describe, expect, it } from 'vitest';

import { Sketch, SKETCH_RELATIVE_ERROR } from '../../../../src/internal/stats/sketch.js';

// A deterministic generator, so a failure reproduces.
function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const exact = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(q * (sorted.length - 1))] as number;
};

const QUANTILES = [0.5, 0.9, 0.95, 0.99, 0.999];

const shapes: Record<string, (random: () => number) => number> = {
  uniform: (random) => 1 + random() * 5000,
  'long tail': (random) => 50 + -Math.log(1 - random()) * 400 * (random() < 0.02 ? 30 : 1),
  bimodal: (random) => (random() < 0.7 ? 80 + random() * 40 : 4000 + random() * 2000),
};

describe('Sketch accuracy', () => {
  for (const [name, shape] of Object.entries(shapes)) {
    it(`stays within the relative error for ${name} data`, () => {
      const random = rng(42);
      const values = Array.from({ length: 20_000 }, () => shape(random));
      const sketch = new Sketch();
      values.forEach((value) => sketch.add(value));

      for (const q of QUANTILES) {
        const truth = exact(values, q);
        // Rank rounding between two neighbours adds a little to the sketch's own error.
        expect(Math.abs((sketch.quantile(q) as number) - truth) / truth).toBeLessThan(
          SKETCH_RELATIVE_ERROR * 3,
        );
      }
    });
  }

  it('keeps exact count, sum, min and max', () => {
    const sketch = new Sketch();
    [5, 1, 9].forEach((value) => sketch.add(value));

    expect(sketch).toMatchObject({ count: 3, sum: 15, min: 1, max: 9 });
  });

  it('answers undefined when empty, and ignores bad values', () => {
    const sketch = new Sketch();
    [NaN, Infinity, -1].forEach((value) => sketch.add(value));

    expect(sketch.count).toBe(0);
    expect(sketch.quantile(0.5)).toBeUndefined();
  });

  it('puts values at or below a thousandth into a zero bucket', () => {
    const sketch = new Sketch();
    [0, 0, 0, 0.0005, 100].forEach((value) => sketch.add(value));

    expect(sketch.quantile(0.5)).toBe(0);
    expect(sketch.quantile(1)).toBe(100);
  });

  it('clamps an estimate to the observed range', () => {
    const sketch = new Sketch();
    sketch.add(123.456);

    expect(sketch.quantile(0.5)).toBe(123.456);
  });

  it('merges as if every value had been added to one sketch', () => {
    const random = rng(7);
    const values = Array.from({ length: 5000 }, () => 1 + random() * 3000);
    const whole = new Sketch();
    const left = new Sketch();
    const right = new Sketch();
    values.forEach((value, index) => {
      whole.add(value);
      (index % 2 ? left : right).add(value);
    });
    left.merge(right);

    expect(left.count).toBe(whole.count);
    for (const q of QUANTILES) expect(left.quantile(q)).toBe(whole.quantile(q));
  });

  it('stays bounded and keeps the top accurate across a span past the bucket cap', () => {
    const sketch = new Sketch();
    // 1e-3 to 1e12 is far wider than 2,048 buckets of 2% each, so the lowest ones collapse.
    for (let exponent = -2.9; exponent <= 12; exponent += 0.01) sketch.add(10 ** exponent);
    const top = sketch.max;

    expect(sketch.count).toBeGreaterThan(1000);
    expect(Math.abs((sketch.quantile(1) as number) - top) / top).toBeLessThan(0.03);
  });

  it('grows downwards when a smaller value arrives after a larger one', () => {
    const sketch = new Sketch();
    sketch.add(5000);
    sketch.add(2);

    expect(Math.abs((sketch.quantile(0) as number) - 2) / 2).toBeLessThan(0.03);
    expect(Math.abs((sketch.quantile(1) as number) - 5000) / 5000).toBeLessThan(0.03);
  });

  it('clears to a usable empty sketch', () => {
    const sketch = new Sketch();
    sketch.add(10);
    sketch.clear();
    sketch.add(20);

    expect(sketch).toMatchObject({ count: 1, min: 20, max: 20 });
  });
});

describe('Sketch bounds', () => {
  it('ignores an empty sketch when merging', () => {
    const sketch = new Sketch();
    sketch.add(5);
    sketch.merge(new Sketch());

    expect(sketch.count).toBe(1);
  });

  it('folds into the lowest bucket once the range passes the cap', () => {
    const sketch = new Sketch();
    sketch.add(1);
    sketch.add(1e30);
    sketch.add(1e60);

    expect(sketch.count).toBe(3);
    expect((sketch.quantile(1) as number) / 1e60).toBeCloseTo(1, 1);
    expect(sketch.quantile(0)).toBeGreaterThan(0);
  });

  it('grows downwards, then folds a value below the bound into the lowest bucket', () => {
    const sketch = new Sketch();
    sketch.add(1e30);
    sketch.add(1);
    sketch.add(0.002);
    sketch.add(0.002);

    expect(sketch.count).toBe(4);
    expect(sketch.quantile(0)).toBeGreaterThan(0);
  });

  it('keeps the total when the whole span is folded away', () => {
    const sketch = new Sketch();
    sketch.add(1);
    sketch.add(1e200);

    expect(sketch.count).toBe(2);
    expect(sketch.quantile(0.5)).toBeGreaterThan(0);
  });

  it('drops only the buckets below the cap when part of the span survives', () => {
    const sketch = new Sketch();
    sketch.add(1);
    sketch.add(1e10);
    sketch.add(1e20);

    expect(sketch.count).toBe(3);
    expect((sketch.quantile(1) as number) / 1e20).toBeCloseTo(1, 1);
    expect(sketch.quantile(0.5)).toBeGreaterThan(1);
  });
});
