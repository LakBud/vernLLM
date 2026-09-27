import { describe, expect, it, vi } from 'vitest';

import {
  runDispatch,
  type DispatchHook,
} from '../../../../../../src/internal/execution/utils/middleware/middleware.utils.js';
import { LLMError } from '../../../../../../src/types/errors.js';
import { baseCtx, baseRequest } from './middleware.helpers.js';

import type { VernLLMMiddleware } from '../../../../../../src/types/index.js';
import type { WireCallRequest } from '../../../../../../src/types/middleware.js';

function dispatchHook(
  label: string,
  dispatch: NonNullable<VernLLMMiddleware['dispatch']>,
): DispatchHook {
  return { entry: { name: label, dispatch }, label };
}

function dispatchParams(hooks: DispatchHook[], send: () => Promise<void>) {
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { request: baseRequest, hooks, ctx: baseCtx(), send, logger };
}

describe('runDispatch', () => {
  it('sends the request directly when no hook is enabled', async () => {
    const send = vi.fn(async () => {});

    await runDispatch(dispatchParams([], send));

    expect(send).toHaveBeenCalledOnce();
  });

  it('nests hooks outermost first, with the request sent inside the innermost', async () => {
    const order: string[] = [];
    const send = vi.fn(async () => {
      order.push('send');
    });
    const around =
      (label: string): NonNullable<VernLLMMiddleware['dispatch']> =>
      async (_request, next) => {
        order.push(`${label}:before`);
        await next();
        order.push(`${label}:after`);
      };

    await runDispatch(
      dispatchParams(
        [dispatchHook('outer', around('outer')), dispatchHook('inner', around('inner'))],
        send,
      ),
    );

    expect(order).toEqual(['outer:before', 'inner:before', 'send', 'inner:after', 'outer:after']);
  });

  it('hands each hook its own copy of the request, so a mutation never reaches the provider', async () => {
    const seen: WireCallRequest[] = [];
    const hook = dispatchHook('mutator', async (request, next) => {
      (request as WireCallRequest).max_tokens = 1;
      seen.push(request as WireCallRequest);
      await next();
    });

    await runDispatch(dispatchParams([hook], async () => {}));

    expect(seen[0]).not.toBe(baseRequest);
    expect(baseRequest.max_tokens).toBe(100);
  });

  it('gives the hook its own ctx.own for the call', async () => {
    let own: Record<string, unknown> | undefined;
    const hook = dispatchHook('own', async (_request, next, ctx) => {
      own = ctx.own;
      await next();
    });
    const params = dispatchParams([hook], async () => {});

    await runDispatch(params);

    expect(own).toBeDefined();
    expect(own).not.toBe(params.ctx.own);
  });

  it('sends once when a hook calls next() twice', async () => {
    const send = vi.fn(async () => {});
    const hook = dispatchHook('twice', async (_request, next) => {
      await Promise.all([next(), next()]);
    });

    await runDispatch(dispatchParams([hook], send));

    expect(send).toHaveBeenCalledOnce();
  });

  it('fails with middleware_threw and sends nothing when a hook returns without calling next()', async () => {
    const send = vi.fn(async () => {});
    const hook = dispatchHook('skipper', async () => {});

    const error = await runDispatch(dispatchParams([hook], send)).catch((e: unknown) => e);

    expect(send).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(LLMError);
    expect((error as LLMError).type).toBe('invalid_params');
    expect((error as LLMError).code).toBe('middleware_threw');
    expect((error as LLMError).message).toContain('"skipper".dispatch');
  });

  it('fails the attempt with the reclassified error when a hook throws before calling next()', async () => {
    const send = vi.fn(async () => {});
    const hook = dispatchHook('broken', async () => {
      throw new Error('boom');
    });

    const error = await runDispatch(dispatchParams([hook], send)).catch((e: unknown) => e);

    expect(send).not.toHaveBeenCalled();
    expect((error as LLMError).code).toBe('middleware_threw');
    expect((error as LLMError).message).toContain('middleware "broken" threw');
    expect((error as LLMError).cause).toEqual(new Error('boom'));
  });

  it('keeps a successful outcome and logs when a hook throws after next() resolved', async () => {
    const hook = dispatchHook('late', async (_request, next) => {
      await next();
      throw new Error('after');
    });
    const params = dispatchParams([hook], async () => {});

    await expect(runDispatch(params)).resolves.toBeUndefined();

    expect(params.logger.error).toHaveBeenCalledWith(
      '[VernLLM] middleware "late".dispatch failed',
      expect.objectContaining({ message: 'after', stack: expect.any(String) }),
    );
  });

  it('waits for the request when a hook calls next() without awaiting it', async () => {
    let settled = false;
    const hook = dispatchHook('fire-and-forget', async (_request, next) => {
      void next();
    });
    const send = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      settled = true;
    };

    await runDispatch(dispatchParams([hook], send));

    expect(settled).toBe(true);
  });

  it("rejects with the provider's error, without logging a hook that just rethrew it", async () => {
    const providerError = new LLMError('upstream', 'api', { status: 503 });
    const hook = dispatchHook('rethrow', async (_request, next) => {
      await next();
    });
    const params = dispatchParams([hook], async () => {
      throw providerError;
    });

    await expect(runDispatch(params)).rejects.toBe(providerError);
    expect(params.logger.error).not.toHaveBeenCalled();
  });

  it("keeps the provider's error when a hook throws a different one, and logs the hook's", async () => {
    const providerError = new LLMError('upstream', 'api', { status: 503 });
    const hook = dispatchHook('replacer', async (_request, next) => {
      await next().catch(() => {
        throw new Error('replacement');
      });
    });
    const params = dispatchParams([hook], async () => {
      throw providerError;
    });

    await expect(runDispatch(params)).rejects.toBe(providerError);
    expect(params.logger.error).toHaveBeenCalledWith(
      '[VernLLM] middleware "replacer".dispatch failed',
      expect.objectContaining({ message: 'replacement' }),
    );
  });

  it("can't hide a provider failure by swallowing next()'s rejection", async () => {
    const providerError = new LLMError('upstream', 'api', { status: 503 });
    const hook = dispatchHook('swallower', async (_request, next) => {
      await next().catch(() => {});
    });

    await expect(
      runDispatch(
        dispatchParams([hook], async () => {
          throw providerError;
        }),
      ),
    ).rejects.toBe(providerError);
  });
});
