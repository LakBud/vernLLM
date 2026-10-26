import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { hedgeMiddleware, type HedgeOptions } from '../../src/index.js';
import { eventProbe, heldClient, settle, targetChain, waitFor } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };
const breaker = { threshold: 1, cooldownMs: 60_000 };

/**
 * The hedge has no health option: every hedge attempt goes through the same breakers and limiters
 * as any attempt, so these tests only configure the core and watch where the hedge goes.
 */
function setup(
  options: HedgeOptions,
  entries: Parameters<typeof targetChain>[0],
  rateLimits: Record<string, { requestsPerMinute: number; maxQueueMs: number }> = {},
) {
  const chain = targetChain(entries);
  const probe = eventProbe('hedge.decision');
  const llm = new VernLLM({
    ...chain.options,
    circuitBreaker: breaker,
    fallback: [chain.options.fallback ?? []].flat().map((target) => ({
      ...target,
      circuitBreaker: breaker,
      rateLimit: rateLimits[target.name!],
    })),
    middleware: [
      probe.middleware as never,
      hedgeMiddleware({ logger: 'silent', budget: { ratio: 1, burst: 1 }, ...options }),
    ],
  });
  return { llm, chain, events: probe.events as Record<string, unknown>[] };
}

describe('breakers', () => {
  it('contact no provider for a hedge target that is open, and move on to the next', async () => {
    const primary = heldClient('primary');
    const { llm, chain, events } = setup({ delay: 10 }, { primary: primary.client });
    llm.openCircuit({ index: 1 });

    expect(await llm.call(call)).toBe('c');

    // `b` is never contacted: its open breaker failed the attempt before the provider.
    expect(chain.tried()).toEqual(['primary', 'c']);
    expect(events[0]).toMatchObject({ outcome: 'won', target: 'b' });
  });

  it('leave the call waiting for its own answer when every hedge target is open', async () => {
    const primary = heldClient('primary');
    const { llm, chain, events } = setup({ delay: 10 }, { primary: primary.client });
    llm.openCircuit({ index: 1 });
    llm.openCircuit({ index: 2 });

    const pending = llm.call(call);
    await waitFor(() => primary.requests.length === 1);
    await settle(40);
    primary.requests[0]!.answer();

    expect(await pending).toBe('primary');
    expect(chain.tried()).toEqual(['primary']);
    expect(events[0]).toMatchObject({ outcome: 'lost', target: 'b' });
  });

  it('do not count a cancelled chain as a failure', async () => {
    const primary = heldClient('primary');
    const { llm } = setup({ delay: 10 }, { primary: primary.client });

    await llm.call(call);
    await settle();

    // The primary was cancelled because the hedge answered first; that is not an outage.
    expect(llm.getCircuitStates()[0]?.state).toBe('closed');
  });
});

describe('limiters', () => {
  it('apply to a hedge attempt like any other, so an exhausted target is passed over', async () => {
    const primary = heldClient('primary');
    const { llm, chain, events } = setup(
      { delay: 10 },
      { primary: primary.client },
      { b: { requestsPerMinute: 1, maxQueueMs: 20 } },
    );

    // Uses the one request `b` is allowed this minute.
    expect(await llm.call({ ...call, targets: ['b'] })).toBe('b');

    expect(await llm.call(call)).toBe('c');

    expect(chain.tried()).toEqual(['b', 'primary', 'c']);
    expect(events.at(-1)).toMatchObject({ outcome: 'won', target: 'b' });
  });
});
