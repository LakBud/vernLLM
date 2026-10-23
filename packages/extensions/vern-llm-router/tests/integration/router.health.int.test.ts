import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { routerMiddleware, type RouterOptions } from '../../src/index.js';
import { captureLogger, eventProbe, targetChain } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };
const breaker = { threshold: 1, cooldownMs: 40 };

function setup(router: RouterOptions = {}, chain = targetChain()) {
  const probe = eventProbe('router.decision');
  const llm: VernLLM = new VernLLM({
    ...chain.options,
    circuitBreaker: breaker,
    fallback: [chain.options.fallback ?? []].flat().map((target) => ({
      ...target,
      circuitBreaker: breaker,
    })),
    middleware: [
      probe.middleware as never,
      routerMiddleware({ logger: 'silent', health: () => llm, ...router }),
    ],
  });
  return { llm, chain, events: probe.events as Record<string, unknown>[] };
}

describe('health', () => {
  it('moves a target with an open breaker last, keeping the rest in order', async () => {
    const { llm, chain, events } = setup();
    llm.openCircuit({ index: 0 });

    await llm.call(call);

    expect(chain.tried()).toEqual(['b']);
    expect(events[0]).toMatchObject({
      order: ['b', 'c', 'primary'],
      demoted: [{ target: 'primary', reason: 'open' }],
    });
  });

  it('keeps a half open target in place so its trial runs', async () => {
    const { llm, chain, events } = setup();
    llm.openCircuit({ index: 0 });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(llm.getCircuitStates()[0]?.state).toBe('half-open');

    await llm.call(call);

    expect(chain.tried()).toEqual(['primary']);
    expect(events[0]).toMatchObject({ order: ['primary', 'b', 'c'], demoted: [] });
  });

  it('leaves the order unchanged when every target is open', async () => {
    const { llm, events } = setup();
    for (const index of [0, 1, 2]) llm.openCircuit({ index });

    await llm.call(call).catch(() => undefined);

    expect(events[0]).toMatchObject({ order: ['primary', 'b', 'c'], demoted: [] });
  });

  it('demotes across the tiers of a route, not inside them', async () => {
    const { llm, events } = setup({ routes: [{ name: 'r', targets: [['primary', 'b'], ['c']] }] });
    llm.openCircuit({ index: 0 });

    await llm.call(call);

    expect(events[0]).toMatchObject({ order: ['b', 'c', 'primary'] });
  });

  it('keeps an open target in place on a route with health: false', async () => {
    const { llm, chain, events } = setup({ routes: [{ name: 'r', health: false }] });
    llm.openCircuit({ index: 0 });

    await llm.call(call);

    // The open primary still comes first, so it fails fast and the call falls back.
    expect(chain.tried()).toEqual(['b']);
    expect(events[0]).toMatchObject({ order: ['primary', 'b', 'c'], demoted: [] });
  });

  it('demotes a target whose local rate limit is exhausted', async () => {
    const levels: Record<number, { requestsRemaining?: number; tokensRemaining?: number }> = {
      0: { requestsRemaining: 0 },
      1: { tokensRemaining: 1 },
      2: { requestsRemaining: 5, tokensRemaining: 1_000_000 },
    };
    const { llm, events } = setup({
      health: () => ({
        getCircuitStates: () => llm.getCircuitStates(),
        getRateLimitState: ({ index }) => levels[index],
      }),
    });

    await llm.call(call);

    expect(events[0]).toMatchObject({
      order: ['c', 'primary', 'b'],
      demoted: [
        { target: 'primary', reason: 'limited' },
        { target: 'b', reason: 'limited' },
      ],
    });
  });

  it('puts a limited target ahead of an open one', async () => {
    const { llm, events } = setup({
      health: () => ({
        getCircuitStates: () => llm.getCircuitStates(),
        getRateLimitState: ({ index }) => (index === 1 ? { requestsRemaining: 0 } : undefined),
      }),
    });
    llm.openCircuit({ index: 0 });

    await llm.call(call);

    expect(events[0]).toMatchObject({ order: ['c', 'b', 'primary'] });
  });

  it('does nothing without a health source', async () => {
    const { llm, events } = setup({ health: undefined });
    llm.openCircuit({ index: 0 });

    await llm.call(call).catch(() => undefined);

    expect(events[0]).toMatchObject({ order: ['primary', 'b', 'c'], demoted: [] });
  });

  it('treats a throwing source as unknown, reports it, and still routes', async () => {
    const log = captureLogger();
    const { llm, chain, events } = setup({
      logger: log.logger,
      health: () => ({
        getCircuitStates: () => {
          throw new Error('source down');
        },
        getRateLimitState: () => {
          throw new Error('limiter down');
        },
      }),
      routes: [{ name: 'r', targets: ['b'] }],
    });

    await llm.call(call);

    expect(chain.tried()).toEqual(['b']);
    expect(events[0]).toMatchObject({ order: ['b'], demoted: [] });
    expect(log.errors().join('\n')).toContain('getCircuitStates failed');
  });

  it('survives a health getter that throws', async () => {
    const log = captureLogger();
    const { llm, chain } = setup({
      logger: log.logger,
      health: () => {
        throw new Error('no llm yet');
      },
    });

    await llm.call(call);

    expect(chain.tried()).toEqual(['primary']);
    expect(log.errors()[0]).toContain('health failed');
  });
});
