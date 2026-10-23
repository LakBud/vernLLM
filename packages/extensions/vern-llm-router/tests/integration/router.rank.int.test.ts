import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { routerMiddleware, type RouterOptions, type StatsSource } from '../../src/index.js';
import { eventProbe, targetChain } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

type Latency = Record<string, number | undefined>;

/** Stats answering `attemptMs` per provider, quality rates per provider and route. */
function stats(options: {
  attemptMs?: Latency;
  streamed?: Latency;
  speed?: Latency;
  tokens?: number;
  rates?: Record<string, number>;
}): StatsSource {
  return {
    quantile: (filter, _q, metric) => {
      if (metric === 'attemptMs') {
        const table = filter.streaming === 'true' ? options.streamed : options.attemptMs;
        return table?.[filter.provider as string];
      }
      if (metric === 'outputTokensPerSec') return options.speed?.[filter.provider as string];
      if (metric === 'outputTokens') return options.tokens;
      return undefined;
    },
    failureRate: (filter) => options.rates?.[`${filter.provider}|${filter.route ?? ''}`],
  };
}

function setup(router: RouterOptions) {
  const chain = targetChain();
  const probe = eventProbe('router.decision');
  const llm = new VernLLM({
    ...chain.options,
    middleware: [
      probe.middleware as never,
      routerMiddleware({ logger: 'silent', random: () => 0, statsTtlMs: 0, ...router }),
    ],
  });
  return { llm, chain, events: probe.events as Record<string, unknown>[] };
}

const rank = (weights: object, extra: object = {}) => ({
  type: 'rank' as const,
  weights,
  explore: 0,
  tolerance: 0,
  ...extra,
});

describe('rank', () => {
  it('sends the call to the lowest latency target and reports scores', async () => {
    const { llm, chain, events } = setup({
      stats: stats({ attemptMs: { primary: 800, b: 200, c: 400 } }),
      routes: [{ name: 'fast', strategy: rank({ latency: 1 }) }],
    });

    await llm.call(call);

    expect(chain.tried()).toEqual(['b']);
    expect(events[0]).toMatchObject({
      strategy: 'rank',
      order: ['b', 'c', 'primary'],
      scores: { b: 0, c: 1, primary: 2 },
      explored: false,
    });
  });

  it('weighs cost and latency together with the balanced shorthand', async () => {
    const prices: Record<string, number> = { primary: 0.002, b: 0.01, c: 0.2 };
    const { llm, chain } = setup({
      stats: stats({ attemptMs: { primary: 800, b: 500, c: 450 } }),
      cost: (target) => prices[target.name],
      routes: [{ name: 'balanced', strategy: { ...rank({ latency: 0.5, cost: 0.5 }) } }],
    });

    await llm.call(call);

    expect(chain.tried()).toEqual(['primary']);
  });

  it('uses the streaming flag of the call for plain latency', async () => {
    const { llm, chain } = setup({
      stats: {
        quantile: (filter) =>
          filter.streaming === 'false' ? (filter.provider === 'c' ? 1 : 900) : 50,
      },
      routes: [{ name: 'fast', strategy: rank({ latency: 1 }) }],
    });

    await llm.call(call);

    expect(chain.tried()).toEqual(['c']);
  });

  it('predicts a slow starting, fast generating target to win a long answer and lose a short one', async () => {
    const options = {
      streamed: { primary: 100, b: 1500 },
      speed: { primary: 20, b: 200 },
    };
    const routes = [{ name: 'p', strategy: rank({ predictedLatency: 1 }) }];

    const long = setup({
      stats: stats({ ...options, tokens: 800 }),
      routes,
    });
    await long.llm.call({ ...call, maxTokens: 2000 } as never);
    // primary: 100 + 800/20*1000 = 40100 ms. b: 1500 + 800/200*1000 = 5500 ms.
    expect(long.chain.tried()).toEqual(['b']);

    const short = setup({
      stats: stats({ ...options, tokens: 10 }),
      routes,
    });
    await short.llm.call(call);
    // primary: 100 + 10/20*1000 = 600 ms. b: 1500 + 50 = 1550 ms.
    expect(short.chain.tried()).toEqual(['primary']);
  });

  it("demotes a target that fails one route's schema on that route only", async () => {
    const { llm, chain, events } = setup({
      stats: stats({ rates: { 'primary|extract': 0.5, 'primary|': 0.01, 'b|extract': 0.01 } }),
      routes: [
        {
          name: 'extract',
          when: { context: { feature: 'extract' } },
          strategy: rank({ quality: 1 }),
        },
        { name: 'chat', strategy: rank({ quality: 1 }) },
      ],
    });

    await llm.call({ ...call, context: { feature: 'extract' } });
    await llm.call({ ...call, context: { feature: 'chat' } });

    expect(events[0]).toMatchObject({ route: 'extract' });
    expect((events[0]?.order as string[] | undefined)?.[0]).not.toBe('primary');
    expect(events[1]).toMatchObject({ route: 'chat' });
    expect(chain.tried()).toHaveLength(2);
  });

  it('stops a cheap but failing target from looking cheap with effectiveCost', async () => {
    const { llm, chain } = setup({
      stats: stats({ rates: { 'primary|r': 0.8 } }),
      cost: (target) => (target.name === 'primary' ? 1 : 3),
      routes: [{ name: 'r', strategy: rank({ effectiveCost: 1 }) }],
    });

    await llm.call(call);

    // primary is $1 / (1 - 0.8) = $5 per usable answer; b and c are $3.
    expect(chain.tried()).toEqual(['b']);
  });

  it("scores a custom metric from the call's context", async () => {
    const { llm, chain } = setup({
      routes: [
        {
          name: 'r',
          strategy: rank(
            { custom: 1 },
            {
              custom: (
                candidate: { name: string },
                callInfo: { context?: { complexity?: string } },
              ) => (callInfo.context?.complexity === 'hard' && candidate.name === 'c' ? 1 : 2),
            },
          ),
        },
      ],
    });

    await llm.call({ ...call, context: { complexity: 'hard' } });

    expect(chain.tried()).toEqual(['c']);
  });

  it('marks an exploration pick', async () => {
    const draws = [0, 0.9];
    const { llm, chain, events } = setup({
      random: () => draws.shift() ?? 0.99,
      stats: stats({ attemptMs: { primary: 100, b: 9000, c: 9000 } }),
      routes: [{ name: 'r', strategy: rank({ latency: 1 }, { explore: 0.5 }) }],
    });

    await llm.call(call);

    expect(chain.tried()).toEqual(['c']);
    expect(events[0]).toMatchObject({ explored: true });
  });

  it('reuses stats reads within statsTtlMs', async () => {
    let reads = 0;
    const { llm } = setup({
      statsTtlMs: 60_000,
      stats: {
        quantile: () => {
          reads++;
          return 100;
        },
      },
      routes: [{ name: 'r', strategy: rank({ latency: 1 }) }],
    });

    await llm.call(call);
    const afterFirst = reads;
    await llm.call(call);

    expect(afterFirst).toBe(3);
    expect(reads).toBe(afterFirst);
  });
});

describe('limits and deadline', () => {
  it('moves a target over a soft limit behind those within it', async () => {
    const { llm, chain, events } = setup({
      stats: stats({ attemptMs: { primary: 9000, b: 100, c: 200 } }),
      routes: [{ name: 'r', limits: { latencyMs: 1000 } }],
    });

    await llm.call(call);

    expect(chain.tried()).toEqual(['b']);
    expect(events[0]).toMatchObject({
      order: ['b', 'c', 'primary'],
      demoted: [{ target: 'primary', reason: 'over_limit' }],
    });
  });

  it('keeps the order when every target is over the limit', async () => {
    const { llm, events } = setup({
      stats: stats({ attemptMs: { primary: 9000, b: 9000, c: 9000 } }),
      routes: [{ name: 'r', limits: { latencyMs: 1000 } }],
    });

    await llm.call(call);

    expect(events[0]).toMatchObject({ order: ['primary', 'b', 'c'], demoted: [] });
  });

  it('skips a target that cannot answer in the time left, on an ordered route', async () => {
    const { llm, chain, events } = setup({
      stats: stats({ attemptMs: { primary: 9000, b: 100, c: 100 } }),
      routes: [{ name: 'r' }],
    });

    await llm.call({ ...call, deadlineMs: 4000 });

    expect(chain.tried()).toEqual(['b']);
    expect(events[0]).toMatchObject({ demoted: [{ target: 'primary', reason: 'over_deadline' }] });
  });

  it('does nothing about latency without a deadline, and keeps the order when all are too slow', async () => {
    const slow = stats({ attemptMs: { primary: 9000, b: 9000, c: 9000 } });
    const none = setup({ stats: slow, routes: [{ name: 'r' }] });
    await none.llm.call(call);
    expect(none.events[0]).toMatchObject({ demoted: [] });

    const all = setup({ stats: slow, routes: [{ name: 'r' }] });
    await all.llm.call({ ...call, deadlineMs: 4000 });
    expect(all.events[0]).toMatchObject({ order: ['primary', 'b', 'c'], demoted: [] });
  });

  it('prefers the predicted latency over p95 for the deadline', async () => {
    const { llm, chain } = setup({
      stats: stats({
        attemptMs: { primary: 9000, b: 100, c: 100 },
        streamed: { primary: 100 },
        speed: { primary: 1000 },
        tokens: 10,
      }),
      routes: [{ name: 'r' }],
    });

    await llm.call({ ...call, deadlineMs: 4000 });

    // Plain p95 says 9 s, but this short answer is predicted at 110 ms, so primary still goes first.
    expect(chain.tried()).toEqual(['primary']);
  });
});
