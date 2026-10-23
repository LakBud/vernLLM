import { describe, expect, it, vi } from 'vitest';

import { gather, type GatherInput } from '../../../src/internal/gather.utils.js';
import { createGuard } from '../../../src/internal/guard.utils.js';
import { normalizeOptions } from '../../../src/internal/options/normalizeOptions.utils.js';
import { StatsCache } from '../../../src/internal/statsCache.js';
import { TargetState } from '../../../src/internal/targetState.js';
import { captureLogger } from '../../helpers.js';

import type { RouterOptions, StatsSource } from '../../../src/index.js';
import type { WireCallRequest } from 'vern-llm';

const request: WireCallRequest = {
  model: 'm',
  max_tokens: 1000,
  messages: [{ role: 'user', content: 'hi' }],
};
const targets = [
  { name: 'a', index: 0, model: 'ma', adapter: { name: 'x' } },
  { name: 'b', index: 1, model: 'mb', adapter: { name: 'x' } },
];

type Table = Record<string, number | undefined>;

/** A stats source answering from a table keyed `provider|streaming|metric|q`. */
function fakeStats(table: Table, rates: Record<string, number | undefined> = {}): StatsSource {
  return {
    quantile: vi.fn((filter, q, metric) => {
      const key = [filter.provider ?? filter.route, filter.streaming, metric, q].join('|');
      return table[key];
    }),
    failureRate: vi.fn((filter) => rates[`${filter.provider}|${filter.route ?? ''}`]),
  };
}

function setup(
  options: RouterOptions,
  statsTable: Table = {},
  extra: Partial<GatherInput> = {},
  rates: Record<string, number | undefined> = {},
) {
  const stats = fakeStats(statsTable, rates);
  const config = normalizeOptions({ ...options, stats } as never);
  const log = captureLogger();
  const input: GatherInput = {
    targets,
    route: config.routes[0],
    request,
    context: undefined,
    streaming: false,
    deadlineAt: undefined,
    health: undefined,
    stats: new StatsCache(stats, 0),
    cost: options.cost,
    state: new TargetState(1000),
    facts: {
      hasTools: false,
      jsonOutput: false,
      jsonSchema: false,
      images: false,
      maxTokens: 1000,
      inputTokens: 5,
    },
    guard: createGuard(log.logger),
    now: 0,
    ...extra,
  };
  return { signals: gather(input), stats, log };
}

const rank = (weights: object, extra: object = {}) => ({
  routes: [{ name: 'r', strategy: { type: 'rank' as const, weights, ...extra } }],
});

describe('gather', () => {
  it("reads latency for this call's streaming flag at the route's quantile", () => {
    const { signals } = setup(rank({ latency: 1 }, { q: 0.9 }), {
      'a|false|attemptMs|0.9': 300,
      'b|false|attemptMs|0.9': 500,
      'a|true|attemptMs|0.9': 1,
    });
    expect(signals.get('a')?.latencyMs).toBe(300);
    expect(signals.get('b')?.latencyMs).toBe(500);
  });

  it('reads only what the route uses', () => {
    const { stats } = setup({ routes: [{ name: 'r' }] }, { 'a|false|attemptMs|0.95': 1 });
    expect(stats.quantile).not.toHaveBeenCalled();
    expect(stats.failureRate).not.toHaveBeenCalled();
  });

  it("predicts latency from the streamed start, the slow tail speed and the route's typical answer", () => {
    const { signals } = setup(rank({ predictedLatency: 1 }), {
      'a|false|attemptMs|0.95': 9999,
      'a|true|attemptMs|0.95': 400,
      // The slow tail of generation speed is the 5th percentile.
      'a|true|outputTokensPerSec|0.05': 50,
      'r||outputTokens|0.5': 200,
    });
    // 400 ms to start, then 200 tokens at 50 tokens per second = 4000 ms.
    expect(signals.get('a')?.predictedLatencyMs).toBe(4400);
  });

  it('caps the expected answer at max_tokens, and uses max_tokens with no samples', () => {
    const table = {
      'a|true|attemptMs|0.95': 0,
      'a|true|outputTokensPerSec|0.05': 100,
    };
    const capped = setup(rank({ predictedLatency: 1 }), {
      ...table,
      'r||outputTokens|0.5': 5000,
    });
    expect(capped.signals.get('a')?.predictedLatencyMs).toBe(10_000);

    const none = setup(rank({ predictedLatency: 1 }), table);
    expect(none.signals.get('a')?.predictedLatencyMs).toBe(10_000);
  });

  it('falls back to plain latency when a target has no streamed data', () => {
    const { signals } = setup(rank({ predictedLatency: 1 }), { 'a|false|attemptMs|0.95': 700 });
    expect(signals.get('a')?.predictedLatencyMs).toBe(700);
    expect(signals.get('b')?.predictedLatencyMs).toBeUndefined();
  });

  it('prices the request on each target', () => {
    const cost = vi.fn((target: { name: string }) => (target.name === 'a' ? 0.5 : undefined));
    const { signals } = setup({ ...rank({ cost: 1 }), cost });
    expect(signals.get('a')?.costUsd).toBe(0.5);
    expect(signals.get('b')?.costUsd).toBeUndefined();
    expect(cost).toHaveBeenCalledWith({ name: 'a', model: 'ma' }, request);
  });

  it("reads the route's quality rate first and the target's overall rate below it", () => {
    const { signals } = setup(
      { ...rank({ quality: 1 }), cost: () => 1 },
      {},
      {},
      { 'a|r': 0.4, 'a|': 0.05, 'b|': 0.1 },
    );
    expect(signals.get('a')?.qualityFailureRate).toBe(0.4);
    expect(signals.get('b')?.qualityFailureRate).toBe(0.1);
  });

  it('evaluates a custom metric with the candidate and the call, ignoring non numbers', () => {
    const custom = vi.fn((candidate: { name: string }, _call?: unknown) =>
      candidate.name === 'a' ? 3 : ('x' as unknown as number),
    );
    const { signals } = setup(
      rank({ custom: 1 }, { custom }),
      {},
      { context: { k: 'v' }, streaming: true },
    );
    expect(signals.get('a')?.customValue).toBe(3);
    expect(signals.get('b')?.customValue).toBeUndefined();
    expect(custom.mock.calls[0]?.[0]).toMatchObject({
      name: 'a',
      model: 'ma',
      adapter: { name: 'x' },
    });
    expect(custom.mock.calls[0]?.[1]).toMatchObject({
      context: { k: 'v' },
      streaming: true,
      request,
    });
  });

  it('reads latency for the deadline even on an ordered route', () => {
    const { signals } = setup(
      { routes: [{ name: 'r' }] },
      { 'a|false|attemptMs|0.95': 800 },
      { deadlineAt: 5000 },
    );
    expect(signals.get('a')?.latencyMs).toBe(800);
  });

  it('reports a throwing source once per operation for the call and leaves the signal unknown', () => {
    const stats: StatsSource = {
      quantile: () => {
        throw new Error('stats down');
      },
      failureRate: () => 0,
    };
    const log = captureLogger();
    const config = normalizeOptions({ ...rank({ latency: 1 }), stats } as never);
    const signals = gather({
      targets,
      route: config.routes[0],
      request,
      context: undefined,
      streaming: false,
      deadlineAt: undefined,
      health: undefined,
      stats: new StatsCache(stats, 0),
      cost: undefined,
      state: new TargetState(1000),
      facts: {
        hasTools: false,
        jsonOutput: false,
        jsonSchema: false,
        images: false,
        maxTokens: 1,
        inputTokens: 1,
      },
      guard: createGuard(log.logger),
      now: 0,
    });

    expect(signals.get('a')?.latencyMs).toBeUndefined();
    expect(log.errors()).toHaveLength(1);
  });
});
