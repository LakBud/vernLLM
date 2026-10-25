import { describe, expect, it } from 'vitest';

import { runOperation } from '../../../../../../src/internal/execution/runOperation.js';
import { createMiddlewareStateBag } from '../../../../../../src/types/middleware.js';
import { declared, dependencies, params, requestId } from './runOperation.helpers.js';

import type { ResolvedTarget } from '../../../../../../src/internal/execution/targetOrder.js';
import type { Chain } from '../../../../../../src/internal/execution/utils/middleware/chains.utils.js';
import type {
  CallMeta,
  CallParams,
  CallResult,
  VernLLMMiddleware,
} from '../../../../../../src/types/index.js';

const metaFor = (chain: number): CallMeta => ({
  provider: 'primary',
  model: 'm',
  fallbackIndex: -1,
  usedFallback: false,
  attempts: 1,
  position: 0,
  ...(chain > 0 ? { chain } : {}),
});

/** A `coreOperation` that answers each chain with its own value, and records the chains it saw. */
function core(options: { delay?: (chain: Chain) => Promise<void> } = {}) {
  const chains: Chain[] = [];
  const results = new Map<number, CallResult>();

  const run = async (_targets: readonly ResolvedTarget[], chain: Chain): Promise<CallResult> => {
    chains.push(chain);
    await options.delay?.(chain);

    const result = { value: { from: chain.number }, meta: metaFor(chain.number) };
    results.set(chain.number, result);

    return result;
  };

  return { run, chains, results };
}

const reruns = (wrap: VernLLMMiddleware['wrap'], name = 'reruns'): VernLLMMiddleware => ({
  name,
  reruns: true,
  wrap,
});

const execute = (
  middleware: VernLLMMiddleware[],
  coreOperation: ReturnType<typeof core>['run'],
  callParams: CallParams<unknown> = params,
) =>
  runOperation(
    dependencies({ middleware }),
    callParams,
    requestId,
    createMiddlewareStateBag(),
    declared,
    coreOperation,
  );

describe('runOperation with reruns', () => {
  it('gives a rerun its own chain: next number, its own signal, and no meta of its own to write', async () => {
    const meta: { current?: CallMeta } = {};
    const operation = core();

    await execute(
      [
        reruns(async (_request, next) => {
          await next();
          return next.again!();
        }),
      ],
      operation.run,
      { ...params, meta },
    );

    const [main, rerun] = operation.chains;

    expect(operation.chains.map((chain) => chain.number)).toEqual([0, 1]);
    expect(main!.params.meta).toBe(meta);
    expect(rerun!.params.meta).toBeUndefined();
    expect(rerun!.params.signal).not.toBe(main!.params.signal);
  });

  it('makes the main chain cancellable too, with a signal of its own', async () => {
    const operation = core();

    await execute([reruns(async (_request, next) => next())], operation.run);

    expect(operation.chains[0]!.params.signal).toBeInstanceOf(AbortSignal);
  });

  it('cancels every chain but the one it returned, and leaves the kept chain running', async () => {
    const operation = core();

    const outcome = await execute(
      [
        reruns(async (_request, next) => {
          await next();
          return next.again!();
        }),
      ],
      operation.run,
    );

    const [main, rerun] = operation.chains;

    expect(outcome.value).toEqual({ from: 1 });
    expect(main!.params.signal!.aborted).toBe(true);
    expect(rerun!.params.signal!.aborted).toBe(false);
  });

  it('keeps the chain whose value a rebuilt result carries', async () => {
    const operation = core();

    const outcome = await execute(
      [
        reruns(async (_request, next) => {
          const first = await next();
          await next.again!();

          return { value: first.value };
        }),
      ],
      operation.run,
    );

    expect(outcome.value).toEqual({ from: 0 });
    expect(operation.chains[0]!.params.signal!.aborted).toBe(false);
    expect(operation.chains[1]!.params.signal!.aborted).toBe(true);
  });

  it('cancels a chain that is still pending when the wrap returns another', async () => {
    const never = new Promise<void>(() => {});
    const operation = core({ delay: (chain) => (chain.number === 0 ? never : Promise.resolve()) });

    const outcome = await execute(
      [
        reruns(async (_request, next) => {
          next().catch(() => {});
          return next.again!();
        }),
      ],
      operation.run,
    );

    expect(outcome.value).toEqual({ from: 1 });
    expect(operation.chains[0]!.params.signal!.aborted).toBe(true);
  });

  it('cancels every chain when the wrap throws before one resolved', async () => {
    const never = new Promise<void>(() => {});
    const operation = core({ delay: () => never });

    await expect(
      execute(
        [
          reruns(async (_request, next) => {
            next().catch(() => {});
            next.again!().catch(() => {});
            throw new Error('gave up');
          }),
        ],
        operation.run,
      ),
    ).rejects.toMatchObject({ code: 'middleware_threw' });

    expect(operation.chains.every((chain) => chain.params.signal!.aborted)).toBe(true);
  });

  it('keeps the first chain to resolve when the wrap throws after two did', async () => {
    const operation = core({
      delay: (chain) => new Promise((resolve) => setTimeout(resolve, chain.number === 0 ? 20 : 1)),
    });

    const outcome = await execute(
      [
        reruns(async (_request, next) => {
          await Promise.all([next(), next.again!()]);
          throw new Error('post processing bug');
        }),
      ],
      operation.run,
    );

    expect(outcome.value).toEqual({ from: 1 });
    expect(operation.chains[0]!.params.signal!.aborted).toBe(true);
    expect(operation.chains[1]!.params.signal!.aborted).toBe(false);
  });

  it("writes a kept rerun's meta to the caller, and leaves the main chain's alone", async () => {
    const keptRerun: { current?: CallMeta } = {};
    const keptMain: { current?: CallMeta } = { current: metaFor(0) };

    await execute(
      [
        reruns(async (_request, next) => {
          await next();
          return next.again!();
        }),
      ],
      core().run,
      { ...params, meta: keptRerun },
    );
    await execute(
      [
        reruns(async (_request, next) => {
          const first = await next();
          await next.again!();

          return first;
        }),
      ],
      core().run,
      { ...params, meta: keptMain },
    );

    expect(keptRerun.current).toEqual(metaFor(1));
    expect(keptMain.current).toEqual(metaFor(0));
  });

  it('counts reruns across layers, then hides again and rejects a kept reference', async () => {
    let started = 0;
    let kept: (() => Promise<CallResult>) | undefined;

    const exhaust = (name: string) =>
      reruns(async (_request, next) => {
        const first = await next();

        while (next.again) {
          kept ??= next.again;
          started++;
          await next.again();
        }

        return first;
      }, name);

    const operation = core();

    await execute(
      [
        { ...exhaust('outer'), priority: 1 },
        { ...exhaust('inner'), priority: 2 },
      ],
      operation.run,
    );

    expect(started).toBe(4);
    await expect(kept!()).rejects.toMatchObject({ type: 'invalid_params' });
    expect(Math.max(...operation.chains.map((chain) => chain.number))).toBe(4);
  });

  it('gives a layer inside a rerun the rerun number, and its own reruns the next ones', async () => {
    const operation = core();
    const seenByInner: Array<number | undefined> = [];

    await execute(
      [
        { ...reruns(async (_request, next) => (await next(), next.again!())), priority: 1 },
        {
          ...reruns(async (_request, next, ctx) => {
            seenByInner.push(ctx.chain);
            return next();
          }, 'inner'),
          priority: 2,
        },
      ],
      operation.run,
    );

    expect(seenByInner).toEqual([undefined, 1]);
  });

  it("validates a rerun's targets like next() does, rejecting an unknown name before any chain starts", async () => {
    const operation = core();
    let rejection: unknown;

    await execute(
      [
        reruns(async (_request, next) => {
          const first = await next();
          await next.again!({ targets: ['nope'] }).catch((error: unknown) => {
            rejection = error;
          });

          return first;
        }),
      ],
      operation.run,
    );

    expect(rejection).toMatchObject({ code: 'unknown_target' });
    expect(operation.chains.map((chain) => chain.number)).toEqual([0]);
  });

  it('does not count a rerun rejected for its targets against the limit', async () => {
    const operation = core();

    const outcome = await execute(
      [
        reruns(async (_request, next) => {
          await next();

          for (let attempt = 0; attempt < 6; attempt++) {
            await next.again!({ targets: ['nope'] }).catch(() => {});
          }

          return next.again!();
        }),
      ],
      operation.run,
    );

    expect(outcome.value).toEqual({ from: 1 });
    expect(operation.chains.map((chain) => chain.number)).toEqual([0, 1]);
  });

  it('turns a chain that throws before returning a promise into a rejection of that chain only', async () => {
    const operation = core();
    let rejection: unknown;

    const outcome = await execute(
      [
        reruns(async (_request, next) => {
          const first = await next();
          await next.again!().catch((error: unknown) => {
            rejection = error;
          });

          return first;
        }),
      ],
      (targets, chain) => {
        if (chain.number > 0) throw new Error('sync boom');
        return operation.run(targets, chain);
      },
    );

    expect(outcome.value).toEqual({ from: 0 });
    expect(rejection).toMatchObject({ message: 'sync boom' });
  });
});
