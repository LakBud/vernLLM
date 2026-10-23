import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { routerMiddleware } from '../../src/index.js';
import { captureLogger, eventProbe, targetChain, textResponse } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

function setup(router: Parameters<typeof routerMiddleware>[0], chain = targetChain()) {
  const probe = eventProbe('router.decision');
  const llm = new VernLLM({
    ...chain.options,
    middleware: [probe.middleware as never, routerMiddleware({ logger: 'silent', ...router })],
  });
  return { llm, chain, events: probe.events as Record<string, unknown>[] };
}

describe('ordered', () => {
  it("tries a route's targets in the order it lists them", async () => {
    const { llm, chain, events } = setup({ routes: [{ name: 'r', targets: ['c', 'b'] }] });

    const result = await llm.call(call);

    expect(result).toBe('c');
    expect(chain.tried()).toEqual(['c']);
    expect(events[0]).toMatchObject({ v: 1, route: 'r', strategy: 'ordered', order: ['c', 'b'] });
  });

  it('falls through the ordered targets when one fails', async () => {
    const chain = targetChain({ c: [new Error('boom')] });
    const { llm } = setup({ routes: [{ name: 'r', targets: ['c', 'b'] }] }, chain);

    const result = await llm.call(call);

    expect(result).toBe('b');
    expect(chain.tried()).toEqual(['c', 'b']);
  });

  it('keeps the declared order when no route is configured', async () => {
    const { llm, chain, events } = setup({});

    await llm.call(call);

    expect(chain.tried()).toEqual(['primary']);
    expect(events[0]).toMatchObject({ order: ['primary', 'b', 'c'], applied: true });
    expect(events[0]).not.toHaveProperty('route');
  });
});

describe('match', () => {
  const routes = [
    { name: 'bulk', when: { context: { tier: ['free', 'trial'] } }, targets: ['c'] },
    { name: 'tools', when: { hasTools: true }, targets: ['b'] },
    { name: 'json', when: { jsonOutput: true }, targets: ['b', 'c'] },
    {
      name: 'fn',
      when: (ctx: { context?: Record<string, unknown> }) => ctx.context?.fn === true,
      targets: ['c'],
    },
    { name: 'long', when: { minInputTokens: 100 }, targets: ['b'] },
    { name: 'short', when: { maxInputTokens: 50 }, targets: ['primary'] },
    { name: 'rest' },
  ];

  it('matches on a context value or any of a list', async () => {
    const { llm, events } = setup({ routes });
    await llm.call({ ...call, context: { tier: 'trial' } });
    expect(events[0]).toMatchObject({ route: 'bulk', order: ['c'] });
  });

  it('does not match a context key the call lacks', async () => {
    const { llm, events } = setup({
      routes: [{ name: 'x', when: { context: { a: null } } }, { name: 'y' }],
    });
    await llm.call(call);
    expect(events[0]).toMatchObject({ route: 'y' });
  });

  it('matches on tools and json output', async () => {
    const json = textResponse('{}');
    const { llm, events } = setup(
      { routes },
      targetChain({ primary: [json], b: [json], c: [json] }),
    );
    await llm.call({ ...call, jsonMode: true });
    expect(events[0]).toMatchObject({ route: 'json' });
  });

  it('matches with a function and on estimated input size', async () => {
    const first = setup({ routes });
    await first.llm.call({ ...call, context: { fn: true } });
    expect(first.events[0]).toMatchObject({ route: 'fn' });

    const second = setup({ routes });
    await second.llm.call({ ...call, userContent: 'x'.repeat(1000) });
    expect(second.events[0]).toMatchObject({ route: 'long' });

    const third = setup({ routes });
    await third.llm.call(call);
    expect(third.events[0]).toMatchObject({ route: 'short' });
  });

  it('matches on hasTools', async () => {
    const { llm, events } = setup({
      routes: [{ name: 't', when: { hasTools: true } }, { name: 'n' }],
    });
    await llm.call(call);
    expect(events[0]).toMatchObject({ route: 'n' });
  });
});

describe('order', () => {
  it('uses the first route that matches', async () => {
    const { llm, events } = setup({
      routes: [
        { name: 'one', when: () => true, targets: ['b'] },
        { name: 'two', when: () => true, targets: ['c'] },
      ],
    });
    await llm.call(call);
    expect(events[0]).toMatchObject({ route: 'one' });
  });

  it('keeps the declared order when no route matches', async () => {
    const { llm, events } = setup({
      routes: [{ name: 'never', when: () => false, targets: ['c'] }],
    });
    await llm.call(call);
    expect(events[0]).toMatchObject({ order: ['primary', 'b', 'c'] });
    expect(events[0]).not.toHaveProperty('route');
  });
});

describe('tiers', () => {
  it('flattens tiers in order and lets * take the rest in declared order', async () => {
    const { llm, events } = setup({ routes: [{ name: 'r', targets: [['c'], '*'] }] });
    await llm.call(call);
    expect(events[0]).toMatchObject({ order: ['c', 'primary', 'b'], excluded: [] });
  });

  it('leaves out targets a route never names', async () => {
    const { llm, events } = setup({ routes: [{ name: 'r', targets: [['b', 'c']] }] });
    await llm.call(call);
    expect(events[0]).toMatchObject({
      order: ['b', 'c'],
      excluded: [{ target: 'primary', reason: 'route' }],
    });
  });

  it('ignores a listed target the call does not have', async () => {
    const { llm, events } = setup({
      routes: [{ name: 'r', targets: ['ghost', 'b'] }],
      logger: 'silent',
    });
    await llm.call(call);
    expect(events[0]).toMatchObject({ order: ['b'] });
  });
});

describe('exclude', () => {
  it('drops excluded targets from a route that otherwise takes everything', async () => {
    const { llm, chain, events } = setup({ routes: [{ name: 'r', exclude: ['primary'] }] });
    await llm.call(call);
    expect(chain.tried()).toEqual(['b']);
    expect(events[0]).toMatchObject({
      order: ['b', 'c'],
      excluded: [{ target: 'primary', reason: 'route' }],
    });
  });

  it('passes an empty list when a route leaves nothing, so the core says no_eligible_targets', async () => {
    const log = captureLogger();
    const { llm, chain, events } = setup({
      logger: log.logger,
      routes: [{ name: 'r', exclude: ['primary', 'b', 'c'] }],
    });

    await expect(llm.call(call)).rejects.toMatchObject({ code: 'no_eligible_targets' });
    await expect(llm.call(call)).rejects.toMatchObject({ code: 'no_eligible_targets' });

    expect(chain.tried()).toEqual([]);
    expect(events[0]).toMatchObject({ order: [] });
    // Warned once for the route, not once per call.
    expect(log.warnings().filter((message) => message.includes('leaves no target'))).toHaveLength(
      1,
    );
  });

  it('does not throw in shadow mode, where the declared order still runs', async () => {
    const { llm, chain } = setup({
      apply: false,
      routes: [{ name: 'r', exclude: ['primary', 'b', 'c'] }],
    });
    await llm.call(call);
    expect(chain.tried()).toEqual(['primary']);
  });
});

describe('result', () => {
  it('returns the answer unchanged', async () => {
    const chain = targetChain({ b: [textResponse('from b')] });
    const { llm } = setup({ routes: [{ name: 'r', targets: ['b'] }] }, chain);
    expect(await llm.call(call)).toBe('from b');
  });
});
