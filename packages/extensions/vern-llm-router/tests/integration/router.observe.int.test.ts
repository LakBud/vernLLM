import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { routerMiddleware } from '../../src/index.js';
import { captureLogger, targetChain, textResponse } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

async function outcome(run: () => Promise<unknown>) {
  try {
    return { value: await run() };
  } catch (error) {
    const e = error as { type?: string; code?: string; message: string };
    return { error: { type: e.type, code: e.code, message: e.message } };
  }
}

describe('observe', () => {
  it('returns the same answer with and without the router', async () => {
    const plain = new VernLLM({ ...targetChain().options });
    const routed = new VernLLM({
      ...targetChain().options,
      middleware: [routerMiddleware({ logger: 'silent' })],
    });

    expect(await outcome(() => routed.call(call))).toEqual(await outcome(() => plain.call(call)));
  });

  it('rethrows the same error an attempt failed with', async () => {
    const failing = () =>
      targetChain({
        primary: [new Error('x')],
        b: [Object.assign(new Error('y'), { status: 500 })],
        c: [Object.assign(new Error('z'), { status: 503 })],
      }).options;
    const plain = new VernLLM(failing());
    const routed = new VernLLM({
      ...failing(),
      middleware: [routerMiddleware({ logger: 'silent' })],
    });

    const without = await outcome(() => plain.call(call));
    const withRouter = await outcome(() => routed.call(call));

    expect(withRouter.error).toBeDefined();
    expect(withRouter).toEqual(without);
  });

  it('keeps counting through a failed attempt, and a later call is unaffected', async () => {
    const chain = targetChain({ primary: [new Error('x'), textResponse('ok')] });
    const llm = new VernLLM({
      ...chain.options,
      middleware: [routerMiddleware({ logger: 'silent' })],
    });

    await llm.call(call);
    await expect(llm.call(call)).resolves.toBe('ok');
  });

  it('never breaks an attempt when its own bookkeeping throws', async () => {
    const log = captureLogger();
    const chain = targetChain();
    const llm = new VernLLM({
      ...chain.options,
      middleware: [
        routerMiddleware({
          logger: log.logger,
          slowStartMs: 1,
          health: () => {
            throw new Error('nope');
          },
        }),
      ],
    });

    await expect(llm.call(call)).resolves.toBe('primary');
  });
});
