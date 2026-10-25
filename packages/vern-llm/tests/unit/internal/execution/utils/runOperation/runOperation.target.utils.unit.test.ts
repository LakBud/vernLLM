import { describe, expect, it, vi } from 'vitest';

import { runOperation } from '../../../../../../src/internal/execution/runOperation.js';
import { createMiddlewareStateBag } from '../../../../../../src/types/middleware.js';
import { dependencies, fakeLogger, params, primary, requestId } from './runOperation.helpers.js';

import type { CallExecutor } from '../../../../../../src/internal/execution/callExecutor.js';
import type { ResolvedTarget } from '../../../../../../src/internal/execution/targetOrder.js';
import type { Logger } from '../../../../../../src/logger.js';
import type {
  CallParams,
  TargetInfo,
  VernLLMMiddleware,
} from '../../../../../../src/types/index.js';

describe('runOperation, target order', () => {
  function fakeTarget(name: string, index: number): ResolvedTarget {
    return {
      index,
      executor: {
        providerName: name,
        model: `${name}-model`,
        adapter: { name: `${name}-adapter` },
        jsonObjectModeSupported: true,
        previewRequest: primary.previewRequest,
      } as unknown as CallExecutor,
    };
  }

  const [a, b, c] = [fakeTarget('a', 0), fakeTarget('b', 1), fakeTarget('c', 2)] as [
    ResolvedTarget,
    ResolvedTarget,
    ResolvedTarget,
  ];
  const all = [a, b, c];
  const targetNames = (targets: readonly TargetInfo[]) => targets.map((target) => target.name);
  const executorNames = (targets: readonly ResolvedTarget[]) =>
    targets.map((target) => target.executor.providerName);

  /** Runs `middleware` around a core that records the order it is handed. */
  async function run(
    middleware: VernLLMMiddleware[],
    options: { start?: ResolvedTarget[]; logger?: Logger; params?: CallParams<unknown> } = {},
  ) {
    const core = vi.fn(async (_targets: readonly ResolvedTarget[]) => ({ value: 'ok' }));

    const outcome = await runOperation(
      dependencies({ middleware, targets: all, logger: options.logger }),
      options.params ?? params,
      requestId,
      createMiddlewareStateBag(),
      options.start ?? all,
      core,
    );

    return { outcome, core, handed: () => executorNames(core.mock.calls[0]![0]) };
  }

  it('hands the starting order to coreOperation untouched when there is no wrap to narrow it', async () => {
    const { handed } = await run([], { start: [c, a] });

    expect(handed()).toEqual(['c', 'a']);
  });

  it('hands the starting order to coreOperation when cachedCall already wraps this invocation', async () => {
    const core = vi.fn(async () => ({ value: 'ok' }));
    const narrow: VernLLMMiddleware = {
      name: 'narrow',
      wrap: (_request, next) => next({ targets: ['b'] }),
    };

    await runOperation(
      dependencies({ middleware: [narrow], targets: all }),
      params,
      requestId,
      createMiddlewareStateBag(),
      [c, a],
      core,
      true,
    );

    expect(core).toHaveBeenCalledWith([c, a], expect.objectContaining({ number: 0 }));
  });

  it('shows a wrap the order it starts with as ctx.targets, with name, declared index, model and adapter', async () => {
    let seen: unknown;

    await run(
      [
        {
          name: 'observer',
          wrap: (_request, next, ctx) => {
            seen = ctx.targets;
            return next();
          },
        },
      ],
      { start: [c, a] },
    );

    expect(seen).toEqual([
      { name: 'c', index: 2, model: 'c-model', adapter: { name: 'c-adapter' } },
      { name: 'a', index: 0, model: 'a-model', adapter: { name: 'a-adapter' } },
    ]);
  });

  it('shows the per call model on the primary only', async () => {
    let seen: Array<{ name: string; model: string }> = [];

    await run(
      [
        {
          name: 'observer',
          wrap: (_request, next, ctx) => {
            seen = ctx.targets.map(({ name, model }) => ({ name, model }));
            return next();
          },
        },
      ],
      { params: { ...params, model: 'override-model' } },
    );

    expect(seen).toEqual([
      { name: 'a', model: 'override-model' },
      { name: 'b', model: 'b-model' },
      { name: 'c', model: 'c-model' },
    ]);
  });

  it('hands coreOperation the order left by next({ targets }), reordering and dropping by name', async () => {
    const { handed } = await run([
      { name: 'router', wrap: (_request, next) => next({ targets: ['c', 'a'] }) },
    ]);

    expect(handed()).toEqual(['c', 'a']);
  });

  it('keeps the order it received when next() is called without targets', async () => {
    const { handed } = await run(
      [
        { name: 'plain', wrap: (_request, next) => next() },
        { name: 'empty', wrap: (_request, next) => next({}) },
      ],
      { start: [b, c] },
    );

    expect(handed()).toEqual(['b', 'c']);
  });

  it('narrows across nested wraps, each seeing what the ones outside it left', async () => {
    const seenByInner: string[][] = [];

    const outer: VernLLMMiddleware = {
      name: 'outer',
      position: 'outermost',
      wrap: (_request, next) => next({ targets: ['c', 'b'] }),
    };
    const inner: VernLLMMiddleware = {
      name: 'inner',
      position: 'innermost',
      wrap: (_request, next, ctx) => {
        seenByInner.push(targetNames(ctx.targets));
        return next({ targets: ['b'] });
      },
    };

    const { handed } = await run([inner, outer]);

    expect(seenByInner).toEqual([['c', 'b']]);
    expect(handed()).toEqual(['b']);
  });

  it('passes the order through a middleware that is disabled or has no wrap', async () => {
    const seen: string[][] = [];

    const outer: VernLLMMiddleware = {
      name: 'outer',
      position: 'outermost',
      wrap: (_request, next) => next({ targets: ['c'] }),
    };
    const disabled: VernLLMMiddleware = {
      name: 'disabled',
      enabled: false,
      wrap: (_request, next) => next({ targets: ['a'] }),
    };
    const transformOnly: VernLLMMiddleware = { name: 'transform-only', transform: () => ({}) };
    const inner: VernLLMMiddleware = {
      name: 'inner',
      position: 'innermost',
      wrap: (_request, next, ctx) => {
        seen.push(targetNames(ctx.targets));
        return next();
      },
    };

    const { handed } = await run([inner, transformOnly, disabled, outer]);

    expect(seen).toEqual([['c']]);
    expect(handed()).toEqual(['c']);
  });

  it('drops a target an outer wrap removed instead of adding it back, logging its name once', async () => {
    const logger = fakeLogger();

    const outer: VernLLMMiddleware = {
      name: 'outer',
      position: 'outermost',
      wrap: (_request, next) => next({ targets: ['a', 'b'] }),
    };
    const inner: VernLLMMiddleware = {
      name: 'inner',
      position: 'innermost',
      wrap: (_request, next) => next({ targets: ['c', 'b'] }),
    };

    const { handed } = await run([inner, outer], { logger });

    expect(handed()).toEqual(['b']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[VernLLM:req-1] middleware "inner" asked for target "c", which an outer layer removed; ignoring it',
    );
  });

  it.each([
    ['an unknown name', ['nope'], 'unknown_target'],
    ['an empty order', [], 'no_eligible_targets'],
    ['a repeated name', ['a', 'a'], 'no_eligible_targets'],
  ])(
    'rejects %s from next() with its own code, and never runs coreOperation',
    async (_label, targets, code) => {
      const core = vi.fn(async () => ({ value: 'never' }));

      await expect(
        runOperation(
          dependencies({ middleware: [{ name: 'bad', wrap: (_r, next) => next({ targets }) }] }),
          params,
          requestId,
          createMiddlewareStateBag(),
          all,
          core,
        ),
      ).rejects.toMatchObject({ type: 'invalid_params', code });
      expect(core).not.toHaveBeenCalled();
    },
  );

  it('rejects with no_eligible_targets when every target an inner wrap asks for was removed', async () => {
    const outer: VernLLMMiddleware = {
      name: 'outer',
      position: 'outermost',
      wrap: (_request, next) => next({ targets: ['a'] }),
    };
    const inner: VernLLMMiddleware = {
      name: 'inner',
      position: 'innermost',
      wrap: (_request, next) => next({ targets: ['b', 'c'] }),
    };

    await expect(run([inner, outer])).rejects.toMatchObject({
      type: 'invalid_params',
      code: 'no_eligible_targets',
    });
  });

  it('counts only the first next() call: later calls get its result, not their own targets', async () => {
    const twice: VernLLMMiddleware = {
      name: 'twice',
      wrap: async (_request, next) => {
        const first = await next({ targets: ['b'] });
        await next({ targets: ['c'] });
        return first;
      },
    };

    const { core, handed } = await run([twice]);

    expect(core).toHaveBeenCalledTimes(1);
    expect(handed()).toEqual(['b']);
  });

  it('memoizes a rejected first next() call too, so a retry inside the wrap gets the same error', async () => {
    const retrying: VernLLMMiddleware = {
      name: 'retrying',
      wrap: async (_request, next) => {
        await next({ targets: ['nope'] }).catch(() => {});
        return next({ targets: ['a'] });
      },
    };

    await expect(run([retrying])).rejects.toMatchObject({ code: 'unknown_target' });
  });
});
