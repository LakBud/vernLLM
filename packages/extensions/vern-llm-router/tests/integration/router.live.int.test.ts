import { VernLLM } from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routerMiddleware, type RouterOptions } from '../../src/index.js';
import { eventProbe, rateLimitError, targetChain } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };
const breaker = { threshold: 1, cooldownMs: 60_000 };

function setup(router: RouterOptions = {}, chain = targetChain(), breakers = true) {
  const probe = eventProbe('router.decision');
  const llm: VernLLM = new VernLLM({
    ...chain.options,
    ...(breakers
      ? {
          circuitBreaker: breaker,
          fallback: [chain.options.fallback ?? []].flat().map((target) => ({
            ...target,
            circuitBreaker: breaker,
          })),
        }
      : {}),
    middleware: [
      probe.middleware as never,
      routerMiddleware({ logger: 'silent', health: () => llm, ...router }),
    ],
  });
  return { llm, chain, events: probe.events as Record<string, unknown>[] };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('live', () => {
  it('cools a target down after a provider 429 and brings it back after 5 seconds', async () => {
    const chain = targetChain({ primary: [rateLimitError()] });
    const { llm, events } = setup({}, chain, false);

    await llm.call(call);
    await llm.call(call);

    expect(events[1]).toMatchObject({
      order: ['b', 'c', 'primary'],
      demoted: [{ target: 'primary', reason: 'limited' }],
    });

    vi.setSystemTime(Date.now() + 5_001);
    await llm.call(call);

    expect(events[2]).toMatchObject({ order: ['primary', 'b', 'c'], demoted: [] });
  });

  it('starts warming when a breaker closes, and lets the target give way while it ramps', async () => {
    const { llm, chain, events } = setup({ random: () => 0, slowStartMs: 10_000 });
    llm.openCircuit({ index: 0 });
    llm.closeCircuit({ index: 0 });

    await llm.call(call);

    expect(chain.tried()).toEqual(['b']);
    expect(events[0]).toMatchObject({
      order: ['b', 'primary', 'c'],
      demoted: [{ target: 'primary', reason: 'warming' }],
    });
  });

  it('keeps the target first when the draw says it takes this call', async () => {
    const { llm, events } = setup({ random: () => 0.99, slowStartMs: 10_000 });
    llm.openCircuit({ index: 0 });
    llm.closeCircuit({ index: 0 });

    await llm.call(call);

    expect(events[0]).toMatchObject({ order: ['primary', 'b', 'c'], demoted: [] });
  });

  it('is full traffic again once slowStartMs has passed', async () => {
    const { llm, events } = setup({ random: () => 0, slowStartMs: 10_000 });
    llm.openCircuit({ index: 0 });
    llm.closeCircuit({ index: 0 });
    vi.setSystemTime(Date.now() + 10_001);

    await llm.call(call);

    expect(events[0]).toMatchObject({ order: ['primary', 'b', 'c'], demoted: [] });
  });

  it('does not warm with slowStartMs: 0', async () => {
    const { llm, events } = setup({ random: () => 0, slowStartMs: 0 });
    llm.openCircuit({ index: 0 });
    llm.closeCircuit({ index: 0 });

    await llm.call(call);

    expect(events[0]).toMatchObject({ order: ['primary', 'b', 'c'] });
  });

  it('warms also on health: false routes', async () => {
    const { llm, events } = setup({
      random: () => 0,
      routes: [{ name: 'r', health: false }],
    });
    llm.openCircuit({ index: 0 });
    llm.closeCircuit({ index: 0 });

    await llm.call(call);

    expect(events[0]).toMatchObject({ order: ['b', 'primary', 'c'] });
  });
});
