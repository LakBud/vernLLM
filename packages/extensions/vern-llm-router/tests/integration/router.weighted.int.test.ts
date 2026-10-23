import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { routerMiddleware, type RouterOptions } from '../../src/index.js';
import { eventProbe, targetChain } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };
const head = (event: Record<string, unknown> | undefined): string | undefined =>
  (event?.order as string[] | undefined)?.[0];

function setup(router: RouterOptions) {
  const chain = targetChain();
  const probe = eventProbe('router.decision');
  const llm = new VernLLM({
    ...chain.options,
    middleware: [probe.middleware as never, routerMiddleware({ logger: 'silent', ...router })],
  });
  return { llm, chain, events: probe.events as Record<string, unknown>[] };
}

describe('weighted', () => {
  it('dispatches the weighted pick and records the strategy', async () => {
    const { llm, chain, events } = setup({
      random: () => 0.99,
      routes: [{ name: 'ab', strategy: { type: 'weighted', weights: { primary: 1, b: 1, c: 8 } } }],
    });

    await llm.call(call);

    expect(chain.tried()).toEqual(['c']);
    expect(events[0]).toMatchObject({
      strategy: 'weighted',
      route: 'ab',
      order: ['c', 'primary', 'b'],
    });
  });

  it('keeps a user on the same first target with stickyBy, whatever the random source says', async () => {
    let draw = 0;
    const { llm, events } = setup({
      random: () => (draw += 0.37) % 1,
      routes: [
        {
          name: 'ab',
          strategy: { type: 'weighted', weights: { primary: 1, b: 1, c: 1 }, stickyBy: 'userId' },
        },
      ],
    });

    for (let i = 0; i < 5; i++) await llm.call({ ...call, context: { userId: 'u-42' } });
    const first = new Set(events.map((event) => head(event)));
    expect(first.size).toBe(1);

    // Different users spread over the targets.
    for (let i = 0; i < 60; i++) await llm.call({ ...call, context: { userId: `user-${i}` } });
    const heads = new Set(events.map((event) => head(event)));
    expect(heads.size).toBe(3);
  });

  it('draws at random for a call without the sticky key', async () => {
    const { llm, events } = setup({
      random: () => 0.99,
      routes: [
        {
          name: 'ab',
          strategy: { type: 'weighted', weights: { primary: 1, b: 1, c: 1 }, stickyBy: 'userId' },
        },
      ],
    });

    await llm.call(call);

    expect(events[0]).toMatchObject({ order: ['c', 'primary', 'b'] });
  });

  it('hashes an object context value', async () => {
    const { llm, events } = setup({
      routes: [
        {
          name: 'ab',
          strategy: { type: 'weighted', weights: { primary: 1, b: 1, c: 1 }, stickyBy: 'org' },
        },
      ],
    });

    await llm.call({ ...call, context: { org: { id: 1 } } });
    await llm.call({ ...call, context: { org: { id: 1 } } });

    expect(head(events[0])).toBe(head(events[1]));
  });

  it('still demotes an open target picked first', async () => {
    const { llm, chain, events } = setup({
      random: () => 0,
      routes: [{ name: 'ab', strategy: { type: 'weighted', weights: { primary: 9, b: 1 } } }],
      health: () => ({
        getCircuitStates: () => [{ provider: 'primary', index: 0, state: 'open' }],
      }),
    });

    await llm.call(call);

    expect(chain.tried()).toEqual(['b']);
    expect(events[0]).toMatchObject({ demoted: [{ target: 'primary', reason: 'open' }] });
  });
});
