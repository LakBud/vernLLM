import { describe, expect, it } from 'vitest';

import { decide } from '../../../src/internal/decide/decide.js';
import { normalizeOptions } from '../../../src/internal/options/normalizeOptions.utils.js';
import { seededRng } from './seededRng.js';

import type { RankStrategy, StrategyOption } from '../../../src/index.js';
import type { Signals } from '../../../src/internal/decide/signals.js';
import type { RequestFacts } from '../../../src/internal/match/requestFacts.utils.js';

const facts: RequestFacts = {
  hasTools: false,
  jsonOutput: false,
  jsonSchema: false,
  images: false,
  maxTokens: 10,
  inputTokens: 10,
};

const stats = { quantile: () => undefined, failureRate: () => undefined };
const cost = () => 1;

type Raw = Record<string, Partial<Signals>>;

function run(
  strategy: StrategyOption,
  raw: Raw,
  extra: { rng?: () => number; targets?: string[]; route?: object } = {},
) {
  const signals = new Map<string, Signals>(
    Object.entries(raw).map(([name, value]) => [
      name,
      { limited: false, warmingFactor: 1, inFlight: 0, ...value },
    ]),
  );
  return decide({
    targets: extra.targets ?? Object.keys(raw),
    route: normalizeOptions({
      routes: [{ name: 'r', strategy, ...extra.route }],
      stats,
      cost,
    } as never).routes[0],
    capabilities: new Map(),
    facts,
    signals,
    rng: extra.rng ?? (() => 0.9999),
  });
}

/** No exploration, so the weighted pick is the only draw. */
const rank = (
  weights: RankStrategy['weights'],
  extra: Partial<RankStrategy> = {},
): RankStrategy => ({
  type: 'rank',
  weights,
  explore: 0,
  custom: () => 1,
  ...extra,
});

describe('rank', () => {
  it('scores the worked example: A wins on 5x cheaper for 1.6x the latency', () => {
    const result = run(rank({ latency: 0.5, cost: 0.5 }, { tolerance: 0 }), {
      A: { costUsd: 0.002, latencyMs: 800 },
      B: { costUsd: 0.01, latencyMs: 500 },
      C: { costUsd: 0.2, latencyMs: 450 },
    });
    expect(result.strategy).toBe('rank');
    expect(result.order).toEqual(['A', 'B', 'C']);
    expect(result.scores).toEqual({ A: 0.42, B: 1.24, C: 3.32 });
    expect(result.explored).toBe(false);
  });

  it('gives the same order for a single metric as the raw values', () => {
    const latencies = { a: 300, b: 120, c: 900, d: 120 };
    const result = run(rank({ latency: 1 }, { tolerance: 0 }), mapLatency(latencies), {
      rng: () => 0,
    });
    expect(result.order).toEqual(['b', 'd', 'a', 'c']);
  });

  it('shortens to latency, cost and balanced', () => {
    const raw = { a: { latencyMs: 100, costUsd: 5 }, b: { latencyMs: 400, costUsd: 1 } };
    expect(run('latency', raw, { rng: () => 0.9999 }).order[0]).toBe('a');
    expect(run('cost', raw, { rng: () => 0.9999 }).order[0]).toBe('b');
    expect(run('balanced', raw).strategy).toBe('rank');
  });

  it('shares first place inside the tolerance and excludes what is outside it', () => {
    const raw = mapLatency({ a: 100, b: 110, c: 200 });
    const strategy = rank({ latency: 1 }, { tolerance: 0.2 });
    const rng = seededRng(9);
    const first = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 10_000; i++) first[run(strategy, raw, { rng }).order[0] as 'a']++;

    expect(first.c).toBe(0);
    // Pick weights are (best / value)^2: 1 and 0.826, so b leads about 45% of the time.
    expect(first.b / 10_000).toBeGreaterThan(0.42);
    expect(first.b / 10_000).toBeLessThan(0.48);
  });

  it('puts a target exactly at the tolerance edge in the top group', () => {
    const raw = mapLatency({ a: 100, b: 120 });
    const strategy = rank({ latency: 1 }, { tolerance: 0.2 });
    const orders = new Set<string>();
    const rng = seededRng(4);
    for (let i = 0; i < 200; i++) orders.add(run(strategy, raw, { rng }).order.join(''));
    expect(orders).toEqual(new Set(['ab', 'ba']));
  });

  it('scores unknown values at the median of the known ones', () => {
    const result = run(rank({ latency: 1 }, { tolerance: 0 }), {
      a: { latencyMs: 100 },
      b: { latencyMs: 400 },
      c: {},
      d: { latencyMs: 0 },
      e: { latencyMs: Number.NaN },
    });
    // known scores: a 0, b 2; median 1. Unknowns (c, d, e) score 1, between a and b.
    expect(result.order).toEqual(['a', 'c', 'd', 'e', 'b']);
  });

  it('drops a metric nobody has, and keeps declared order when nothing is known', () => {
    expect(
      run(rank({ latency: 1, cost: 1 }), { a: { costUsd: 3 }, b: { costUsd: 1 } }).order,
    ).toEqual(['b', 'a']);
    const none = run(rank({ latency: 1 }), { a: {}, b: {}, c: {} });
    expect(none.order).toEqual(['a', 'b', 'c']);
    expect(none.scores).toBeUndefined();
  });

  it('scores quality by smoothed rate and effectiveCost by cost per usable answer', () => {
    const quality = run(rank({ quality: 1 }, { tolerance: 0 }), {
      a: { qualityFailureRate: 0.3 },
      b: { qualityFailureRate: 0 },
    });
    expect(quality.order).toEqual(['b', 'a']);
    expect(quality.scores?.a).toBe(Math.round(Math.log2(0.31 / 0.01) * 100) / 100);

    // $1 failing 20% costs 1.25; $1.1 failing nothing is cheaper per usable answer.
    const effective = run(rank({ effectiveCost: 1 }, { tolerance: 0 }), {
      a: { costUsd: 1, qualityFailureRate: 0.2 },
      b: { costUsd: 1.1 },
    });
    expect(effective.order).toEqual(['b', 'a']);

    // The failure rate is capped at 0.9, so a broken target stays finite (cost 10, not infinite).
    const capped = run(rank({ effectiveCost: 1 }, { tolerance: 0 }), {
      a: { costUsd: 1, qualityFailureRate: 1 },
      b: { costUsd: 20 },
    });
    expect(capped.order).toEqual(['a', 'b']);

    // Unpriced: effectiveCost is unknown, not zero.
    const unpriced = run(rank({ effectiveCost: 1 }, { tolerance: 0 }), {
      a: { qualityFailureRate: 0.5 },
      b: { costUsd: 1 },
    });
    expect(unpriced.order).toEqual(['b', 'a']);
  });

  it('adds weighted custom values to other metrics', () => {
    const result = run(rank({ latency: 1, custom: 1 }, { tolerance: 0 }), {
      a: { latencyMs: 100, customValue: 8 },
      b: { latencyMs: 100, customValue: 2 },
    });
    expect(result.order).toEqual(['b', 'a']);
  });

  it('uses a lone custom metric raw when a value is not positive, and only exact ties share', () => {
    const raw = { a: { customValue: -2 }, b: { customValue: 0 }, c: { customValue: -2 } };
    const orders = new Set<string>();
    const rng = seededRng(2);
    for (let i = 0; i < 100; i++) orders.add(run(rank({ custom: 1 }), raw, { rng }).order.join(''));
    expect([...orders].sort()).toEqual(['acb', 'cab']);
  });

  it('treats a non positive custom value as unknown next to another metric', () => {
    const result = run(
      rank({ latency: 1, custom: 1 }, { tolerance: 0 }),
      {
        a: { latencyMs: 100, customValue: 0 },
        b: { latencyMs: 100, customValue: 4 },
      },
      { rng: () => 0 },
    );
    // a's custom is unknown, so it takes the median of the known (b's 0 score): both tie.
    expect(result.order).toEqual(['a', 'b']);
  });

  it('keeps declared order for a lone custom metric with no finite value', () => {
    const result = run(rank({ custom: 1 }), {
      a: { customValue: Number.NaN },
      b: {},
    });
    expect(result.order).toEqual(['a', 'b']);
  });

  it('breaks exact ties by declared order', () => {
    // Equal scores share first place; the draw picks, and the rest keep declared order.
    const result = run(rank({ latency: 1 }, { tolerance: 0 }), mapLatency({ a: 5, b: 5, c: 5 }), {
      rng: () => 0.5,
    });
    expect(result.order).toEqual(['b', 'a', 'c']);
  });
});

describe('exploration', () => {
  const raw = {
    a: { latencyMs: 100 },
    b: { latencyMs: 5000 },
    c: { latencyMs: 6000, circuit: 'open' as const },
    d: { latencyMs: 7000, limited: true },
    e: { latencyMs: 8000 },
  };
  const strategy = rank({ latency: 1 }, { explore: 0.5 });

  it('picks uniformly among usable targets, never an open or limited one', () => {
    const rng = seededRng(77);
    const first: Record<string, number> = {};
    let explored = 0;
    for (let i = 0; i < 6_000; i++) {
      const result = run(strategy, raw, { rng });
      first[result.order[0] as string] = (first[result.order[0] as string] ?? 0) + 1;
      if (result.explored) explored++;
    }

    expect(first.c).toBeUndefined();
    expect(first.d).toBeUndefined();
    // Explored about half the time, uniformly over a, b, e: each about 1/6 of all calls,
    // while a also leads every non explored call.
    expect(explored / 6_000).toBeGreaterThan(0.45);
    expect((first.b ?? 0) / 6_000).toBeGreaterThan(0.13);
    expect((first.b ?? 0) / 6_000).toBeLessThan(0.2);
    expect((first.e ?? 0) / 6_000).toBeGreaterThan(0.13);
  });

  it('marks an exploration pick and keeps it explored only while it stays first', () => {
    // First draw 0 < explore, second draw 0.5 of 3 usable targets picks b.
    const draws = [0, 0.5];
    const result = run(strategy, raw, { rng: () => draws.shift() ?? 0.99 });
    expect(result.order[0]).toBe('b');
    expect(result.explored).toBe(true);
  });

  it('never explores into a target over a limit', () => {
    // b is over the limit, so only a can be explored, whatever the second draw says.
    const draws = [0, 0.99];
    const result = run(
      rank({ latency: 1 }, { explore: 0.99 }),
      { a: { latencyMs: 100 }, b: { latencyMs: 9000 } },
      { rng: () => draws.shift() ?? 0.5, route: { limits: { latencyMs: 1000 } } },
    );
    expect(result.order).toEqual(['a', 'b']);
  });

  it('falls back to the weighted pick when nothing is usable to explore', () => {
    const result = run(
      rank({ latency: 1 }, { explore: 0.99 }),
      { a: { latencyMs: 100, circuit: 'open' }, b: { latencyMs: 200, limited: true } },
      { rng: () => 0 },
    );
    expect(result.explored).toBe(false);
  });
});

function mapLatency(latencies: Record<string, number>): Raw {
  return Object.fromEntries(
    Object.entries(latencies).map(([name, latencyMs]) => [name, { latencyMs }]),
  );
}
