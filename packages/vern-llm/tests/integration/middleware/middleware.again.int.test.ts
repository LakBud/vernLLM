import { describe, expect, it, vi } from 'vitest';

import { LLMError } from '../../../src/types/errors.js';
import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, FakeApiError, textResponse } from '../../helpers.js';
import { CALL, raceTwo, targetChain } from './middleware.int.helpers.js';

import type {
  CallMeta,
  CallResult,
  VernLLMEvent,
  VernLLMMiddleware,
} from '../../../src/types/index.js';

/** Runs the inside once, then again, and returns the first or the second result. */
function rerunOnce(keep: 'first' | 'second', overrides: Partial<VernLLMMiddleware> = {}) {
  const middleware: VernLLMMiddleware = {
    name: 'rerun-once',
    priority: 1,
    reruns: true,
    wrap: async (_request, next) => {
      const first = await next();
      if (!next.again) return first;

      const second = await next.again();

      return keep === 'first' ? first : second;
    },
    ...overrides,
  };

  return middleware;
}

describe('next.again()', () => {
  it('is undefined for an entry without reruns', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    let seen: unknown = 'unset';

    const middleware: VernLLMMiddleware = {
      name: 'plain',
      wrap: async (_request, next) => {
        seen = next.again;
        return next();
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [middleware] });

    await llm.call(CALL);

    expect(seen).toBeUndefined();
  });

  it('changes nothing for reruns: true when only next() is called', async () => {
    const run = async (reruns: boolean) => {
      const { client, calls } = createMockClient([textResponse('ok')]);
      const events: VernLLMEvent[] = [];
      const meta: { current?: CallMeta } = {};
      const middleware: VernLLMMiddleware = {
        name: 'plain',
        ...(reruns ? { reruns: true } : {}),
        wrap: async (_request, next) => next(),
      };

      const llm = new VernLLM({
        client,
        model: 'test-model',
        middleware: [middleware],
        onEvent: (event) => events.push(event),
      });
      const value = await llm.call({ ...CALL, meta });

      return { value, meta: meta.current, events, calls: calls.length };
    };

    const without = await run(false);
    const withFlag = await run(true);

    expect(withFlag).toEqual(without);
    expect(withFlag.meta).not.toHaveProperty('chain');
  });

  it('runs the layers inside again as a separate chain, and the layers outside once', async () => {
    const { client, calls } = createMockClient([textResponse('first'), textResponse('second')]);
    const count = { outer: 0, inner: 0, transform: 0 };

    const outer: VernLLMMiddleware = {
      name: 'outer',
      priority: 0,
      wrap: async (_request, next) => {
        count.outer++;
        return next();
      },
    };
    const inner: VernLLMMiddleware = {
      name: 'inner',
      priority: 2,
      wrap: async (_request, next) => {
        count.inner++;
        return next();
      },
      transform: () => {
        count.transform++;
        return {};
      },
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [outer, rerunOnce('second'), inner],
    });

    await expect(llm.call(CALL)).resolves.toBe('second');

    expect(calls).toHaveLength(2);
    expect(count).toEqual({ outer: 1, inner: 2, transform: 2 });
  });

  it('narrows targets like next({ targets })', async () => {
    const chain = targetChain([textResponse('p')], [textResponse('b')], [textResponse('c')]);
    const middleware = rerunOnce('first', {
      wrap: async (_request, next) => {
        await next();
        return next.again!({ targets: ['c'] });
      },
    });

    const llm = new VernLLM({ ...chain.options, middleware: [middleware] });

    await expect(llm.call(CALL)).resolves.toBe('c');

    expect(chain.primary.calls).toHaveLength(1);
    expect(chain.c.calls).toHaveLength(1);
    expect(chain.b.calls).toHaveLength(0);
  });

  it('never lets a rerun use a target an outer layer removed, warning as next() does', async () => {
    const chain = targetChain([textResponse('p')], [textResponse('b')], [textResponse('c')]);
    const warn = vi.fn();
    const outer: VernLLMMiddleware = {
      name: 'outer',
      priority: 0,
      wrap: async (_request, next) => next({ targets: ['primary', 'b'] }),
    };
    const rerunner = rerunOnce('second', {
      name: 'rerunner',
      wrap: async (_request, next) => {
        await next();
        return next.again!({ targets: ['c', 'b'] });
      },
    });

    const llm = new VernLLM({
      ...chain.options,
      logger: { debug: vi.fn(), warn, error: vi.fn() },
      middleware: [outer, rerunner],
    });

    await expect(llm.call(CALL)).resolves.toBe('b');

    expect(chain.c.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"rerunner" asked for target "c", which an outer layer removed'),
    );
  });

  it('leaves the caller meta as the main chain wrote it, or holds the kept rerun with its chain', async () => {
    const run = async (keep: 'first' | 'second') => {
      const { client } = createMockClient([textResponse('first'), textResponse('second')]);
      const meta: { current?: CallMeta } = {};
      const llm = new VernLLM({ client, model: 'test-model', middleware: [rerunOnce(keep)] });

      await llm.call({ ...CALL, meta });

      return meta.current;
    };

    const main = await run('first');
    const rerun = await run('second');

    expect(main).toMatchObject({ provider: 'primary', attempts: 1 });
    expect(main).not.toHaveProperty('chain');
    expect(rerun).toMatchObject({ provider: 'primary', attempts: 1, chain: 1 });
  });

  it('gives inner wrap, transform and dispatch contexts the chain number, absent for the main chain', async () => {
    const { client } = createMockClient([textResponse('first'), textResponse('second')]);
    const seen: Record<string, Array<number | undefined>> = {
      wrap: [],
      transform: [],
      dispatch: [],
    };

    const inner: VernLLMMiddleware = {
      name: 'inner',
      priority: 2,
      wrap: async (_request, next, ctx) => {
        seen.wrap!.push(ctx.chain);
        return next();
      },
      transform: (_request, ctx) => {
        seen.transform!.push(ctx.chain);
        return {};
      },
      dispatch: async (_request, next, ctx) => {
        seen.dispatch!.push(ctx.chain);
        return next();
      },
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [rerunOnce('second'), inner],
    });

    await llm.call(CALL);

    expect(seen).toEqual({
      wrap: [undefined, 1],
      transform: [undefined, 1],
      dispatch: [undefined, 1],
    });
  });

  it('keeps ctx.own apart for two chains running through the same inner middleware', async () => {
    const { client } = createMockClient([textResponse('first'), textResponse('second')]);
    const pairs: Array<{ chain: number; own: unknown }> = [];

    const bothAtOnce = rerunOnce('first', {
      wrap: async (_request, next) => {
        const [first] = await Promise.all([next(), next.again!()]);
        return first;
      },
    });
    const inner: VernLLMMiddleware = {
      name: 'inner',
      priority: 2,
      wrap: async (_request, next, ctx) => {
        ctx.own.id = ctx.chain ?? 0;
        // Lets the other chain write its own value before this chain's attempt reads it back.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return next();
      },
      transform: (_request, ctx) => {
        pairs.push({ chain: ctx.chain ?? 0, own: ctx.own.id });
        return {};
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [bothAtOnce, inner] });

    await llm.call(CALL);

    expect(pairs).toHaveLength(2);
    for (const pair of pairs) expect(pair.own).toBe(pair.chain);
  });

  it('gives middleware outside the rerunning wrap one ctx.own for the call, in every hook', async () => {
    const { client } = createMockClient([textResponse('first'), textResponse('second')]);
    const transformOwns: Array<{ chain: number; own: Record<string, unknown> }> = [];
    let wrapOwn: Record<string, unknown> | undefined;

    const outer: VernLLMMiddleware = {
      name: 'outer',
      priority: 0,
      wrap: async (_request, next, ctx) => {
        ctx.own.written = 'by wrap';
        wrapOwn = ctx.own;
        return next();
      },
      transform: (_request, ctx) => {
        transformOwns.push({ chain: ctx.chain ?? 0, own: ctx.own });
        return {};
      },
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [outer, rerunOnce('first')],
    });

    await llm.call(CALL);

    expect(transformOwns.map((entry) => entry.chain).sort()).toEqual([0, 1]);

    for (const entry of transformOwns) {
      expect(entry.own).toBe(wrapOwn);
      expect(entry.own.written).toBe('by wrap');
    }
  });

  it('resolves ctx.own by the chain each entry wrap ran in, with reruns nested', async () => {
    const { client } = createMockClient([textResponse('a'), textResponse('b'), textResponse('c')]);
    const owns = new Map<string, Set<Record<string, unknown>>>();

    const track = (name: string, priority: number, reruns: boolean): VernLLMMiddleware => ({
      name,
      priority,
      ...(reruns ? { reruns: true } : {}),
      wrap: async (_request, next) => {
        if (!reruns) return next();

        const first = await next();
        if (next.again) await next.again();

        return first;
      },
      transform: (_request, ctx) => {
        const seen = owns.get(name) ?? new Set();
        seen.add(ctx.own);
        owns.set(name, seen);
        return {};
      },
    });

    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [
        track('outermost', 0, false),
        track('outer-reruns', 1, true),
        track('middle', 2, false),
        track('inner-reruns', 3, true),
        track('innermost', 4, false),
      ],
    });

    await llm.call(CALL);

    // Outside every rerunning wrap: one object. Between the two: one per outer chain. Innermost:
    // one per chain.
    expect(owns.get('outermost')!.size).toBe(1);
    expect(owns.get('outer-reruns')!.size).toBe(1);
    expect(owns.get('middle')!.size).toBe(2);
    expect(owns.get('inner-reruns')!.size).toBe(2);
    expect(owns.get('innermost')!.size).toBeGreaterThanOrEqual(3);
  });

  it('falls back to a plain next() in a layer that finds no reruns left', async () => {
    const { client, create } = createMockClient([textResponse('ok')]);
    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [raceTwo(undefined, 'a'), raceTwo(undefined, 'b'), raceTwo(undefined, 'c')],
    });

    await expect(llm.call(CALL)).resolves.toBe('ok');

    // 2 chains from the outer layer, 4 from the middle, and the call's 4 reruns run out before
    // every inner chain can start another.
    expect(create.mock.calls.length).toBeLessThan(8);
  });

  it('allows at most 4 reruns per call across layers, then next.again is undefined and a kept reference rejects', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    let started = 0;
    let keptAgain: ((options?: { targets?: readonly string[] }) => Promise<CallResult>) | undefined;

    const exhaust = (name: string, priority: number): VernLLMMiddleware => ({
      name,
      priority,
      reruns: true,
      wrap: async (_request, next) => {
        const first = await next();

        while (next.again) {
          keptAgain ??= next.again;
          started++;
          await next.again();
        }

        return first;
      },
    });

    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [exhaust('outer-reruns', 1), exhaust('inner-reruns', 2)],
    });

    await llm.call(CALL);

    expect(started).toBe(4);
    await expect(keptAgain!()).rejects.toMatchObject({ type: 'invalid_params' });
  });

  it('cancels every chain and warns once when the wrap returns a value no chain produced', async () => {
    const { client } = createMockClient([textResponse('first'), textResponse('second')]);
    const warn = vi.fn();
    const middleware = rerunOnce('first', {
      wrap: async (_request, next) => {
        await next();
        await next.again!();

        return { value: 'made up' } satisfies CallResult;
      },
    });

    const llm = new VernLLM({
      client,
      model: 'test-model',
      logger: { debug: vi.fn(), warn, error: vi.fn() },
      middleware: [middleware],
    });

    await expect(llm.call(CALL)).resolves.toBe('made up');
    await expect(llm.call(CALL)).resolves.toBe('made up');

    const warnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('returned a value no chain produced'),
    );

    expect(warnings).toHaveLength(1);
  });

  it('keeps the first chain to resolve when the wrap throws after one did', async () => {
    const { client } = createMockClient([textResponse('first'), textResponse('second')]);
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const middleware = rerunOnce('first', {
      wrap: async (_request, next) => {
        await next();
        await next.again!();
        throw new Error('post processing bug');
      },
    });

    const llm = new VernLLM({ client, model: 'test-model', logger, middleware: [middleware] });

    await expect(llm.call(CALL)).resolves.toBe('first');
    expect(logger.error).toHaveBeenCalled();
  });

  it('still passes content_blocked through after a chain resolved', async () => {
    const { client } = createMockClient([textResponse('first'), textResponse('second')]);
    const middleware = rerunOnce('first', {
      wrap: async (_request, next) => {
        await next();
        await next.again!();
        throw new LLMError('blocked', 'api', { code: 'content_blocked' });
      },
    });

    const llm = new VernLLM({ client, model: 'test-model', middleware: [middleware] });

    await expect(llm.call(CALL)).rejects.toMatchObject({ code: 'content_blocked' });
  });

  it('never leaves a rejection unhandled when a chain the wrap does not await fails', async () => {
    const { client } = createMockClient([textResponse('first'), new FakeApiError('down', 500)]);
    const unhandled = vi.fn();
    const middleware = rerunOnce('first', {
      wrap: async (_request, next) => {
        const first = await next();
        void next.again!();

        return first;
      },
    });

    process.on('unhandledRejection', unhandled);

    try {
      const llm = new VernLLM({
        client,
        model: 'test-model',
        maxRetries: 0,
        logger: 'silent',
        middleware: [middleware],
      });

      await llm.call(CALL);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', unhandled);
    }

    expect(unhandled).not.toHaveBeenCalled();
  });
});
