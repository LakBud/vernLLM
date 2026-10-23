import { createStateKey, stateEntry, VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { routerMiddleware, routerRouteKey } from '../../src/index.js';
import { captureLogger, eventProbe, targetChain } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

function setup(router: Parameters<typeof routerMiddleware>[0], chain = targetChain()) {
  const probe = eventProbe('router.decision');
  const llm = new VernLLM({
    ...chain.options,
    defaultMaxTokens: 100,
    middleware: [probe.middleware as never, routerMiddleware({ logger: 'silent', ...router })],
  });
  return { llm, chain, events: probe.events as Record<string, unknown>[] };
}

describe('filter', () => {
  it('skips a target whose context window cannot hold the request', async () => {
    const { llm, chain, events } = setup({
      capabilities: { primary: { contextWindow: 120 } },
    });

    await llm.call({ ...call, userContent: 'x'.repeat(1000) });

    expect(chain.tried()).toEqual(['b']);
    expect(events[0]).toMatchObject({
      order: ['b', 'c'],
      excluded: [{ target: 'primary', reason: 'capability' }],
    });
  });

  it('keeps a target that fits, and one with nothing declared', async () => {
    const { llm, chain } = setup({ capabilities: { primary: { contextWindow: 100_000 } } });
    await llm.call(call);
    expect(chain.tried()).toEqual(['primary']);
  });

  it('skips targets that cannot take tools, json schemas or images', async () => {
    const { llm, chain, events } = setup({
      capabilities: {
        primary: { tools: false, jsonSchema: false, images: false },
        b: { jsonSchema: false },
      },
    });
    const tool = {
      name: 'lookup',
      description: 'd',
      parameters: { type: 'object', properties: {} },
    };

    await llm.call({ ...call, tools: [tool] } as never);

    expect(chain.tried()).toEqual(['b']);
    expect(events[0]).toMatchObject({ excluded: [{ target: 'primary', reason: 'capability' }] });
  });

  it('keeps the declared order when every target is filtered out', async () => {
    const { llm, chain, events } = setup({
      capabilities: {
        primary: { contextWindow: 10 },
        b: { contextWindow: 10 },
        c: { contextWindow: 10 },
      },
    });

    await llm.call(call);

    expect(chain.tried()).toEqual(['primary']);
    expect(events[0]).toMatchObject({ order: ['primary', 'b', 'c'], excluded: [] });
  });
});

describe('pinned', () => {
  it('leaves a caller chosen order alone and records it as pinned', async () => {
    const { llm, chain, events } = setup({
      routes: [{ name: 'r', targets: ['primary'] }],
      capabilities: { c: { tools: false } },
    });

    await llm.call({ ...call, targets: ['c', 'b'] });

    expect(chain.tried()).toEqual(['c']);
    expect(events[0]).toMatchObject({ strategy: 'pinned', order: ['c', 'b'], applied: false });
    expect(events[0]).not.toHaveProperty('route');
  });

  it('forces a route by name through routerRouteKey', async () => {
    const { llm, chain, events } = setup({
      routes: [
        { name: 'a', when: () => true, targets: ['b'] },
        { name: 'forced', when: () => false, targets: ['c'] },
      ],
    });

    await llm.call({ ...call, state: [stateEntry(routerRouteKey, 'forced')] });

    expect(chain.tried()).toEqual(['c']);
    expect(events[0]).toMatchObject({ route: 'forced' });
  });

  it('warns once and matches normally when the forced route does not exist', async () => {
    const log = captureLogger();
    const { llm, events } = setup({
      logger: log.logger,
      routes: [{ name: 'a', targets: ['b'] }],
    });
    const state = [stateEntry(routerRouteKey, 'nope')];

    await llm.call({ ...call, state });
    await llm.call({ ...call, state });

    expect(events[1]).toMatchObject({ route: 'a' });
    expect(log.warnings()).toHaveLength(1);
    expect(log.warnings()[0]).toContain('"nope"');
  });
});

describe('shadow', () => {
  it('computes and emits the decision but keeps the declared order', async () => {
    const { llm, chain, events } = setup({
      apply: false,
      routes: [{ name: 'r', targets: ['c'] }],
    });

    await llm.call(call);

    expect(chain.tried()).toEqual(['primary']);
    expect(events[0]).toMatchObject({ route: 'r', order: ['c'], applied: false });
  });
});

describe('cache', () => {
  it('reports applied false for a hit, which never used the order', async () => {
    const { llm, events } = setup({ routes: [{ name: 'r', targets: ['c'] }] });
    const params = { cacheKey: 'k', ttl: 1000, call };

    await llm.cachedCall(params);
    await llm.cachedCall(params);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ applied: true });
    expect(events[1]).toMatchObject({ applied: false });
  });
});

describe('decision event', () => {
  it('is emitted after next() settles, also when every target failed', async () => {
    const chain = targetChain({
      primary: [new Error('x')],
      b: [new Error('x')],
      c: [new Error('x')],
    });
    const { llm, events } = setup({}, chain);

    await expect(llm.call(call)).rejects.toThrow();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ applied: true });
  });
});

describe('policy', () => {
  it('fails open when a route function throws, running the declared order', async () => {
    const log = captureLogger();
    const { llm, chain, events } = setup({
      logger: log.logger,
      routes: [
        {
          name: 'r',
          when: () => {
            throw new Error('bad matcher');
          },
          targets: ['c'],
        },
      ],
    });

    await expect(llm.call(call)).resolves.toBe('primary');

    expect(chain.tried()).toEqual(['primary']);
    expect(events).toHaveLength(0);
    expect(log.errors()[0]).toContain('decide failed');
  });

  it('survives a throwing logger', async () => {
    const { llm } = setup({
      logger: {
        debug: () => {},
        warn: () => {
          throw new Error('logger down');
        },
        error: () => {
          throw new Error('logger down');
        },
      },
      routes: [
        {
          name: 'r',
          when: () => {
            throw new Error('bad matcher');
          },
        },
      ],
    });
    await expect(llm.call(call)).resolves.toBe('primary');
  });

  it('warns once about a route naming a target the call lacks', async () => {
    const log = captureLogger();
    const { llm } = setup({ logger: log.logger, routes: [{ name: 'r', targets: ['ghost', 'b'] }] });

    await llm.call(call);
    await llm.call(call);

    expect(log.warnings()).toHaveLength(1);
    expect(log.warnings()[0]).toContain('"ghost"');
  });

  it('never throws from a state key it does not own', async () => {
    const other = createStateKey<string>('other');
    const { llm } = setup({});
    await expect(llm.call({ ...call, state: [stateEntry(other, 'x')] })).resolves.toBe('primary');
  });
});

describe('sync', () => {
  it('never treats an asynchronous matcher as a match', async () => {
    const { llm, chain, events } = setup({
      routes: [{ name: 'r', when: (async () => true) as never, targets: ['c'] }],
    });

    await llm.call(call);

    expect(chain.tried()).toEqual(['primary']);
    expect(events[0]).not.toHaveProperty('route');
  });
});
