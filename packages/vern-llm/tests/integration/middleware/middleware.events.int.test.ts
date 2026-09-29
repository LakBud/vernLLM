import { describe, expect, it } from 'vitest';

import { type VernLLMMiddleware } from '../../../src/types/index.js';
import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, createMockStreamingClient, FakeApiError } from '../../helpers.js';
import { CALL, fallbackChain, USAGE, withUsage } from './middleware.int.helpers.js';

// An earlier entry with a slow async `enabled`. The delay is far longer than the rest of the call
// takes, so if it held back a later entry's onEvent, the call would already have returned.
function slowGate(): VernLLMMiddleware {
  return {
    name: 'slow-gate',
    priority: -10,
    enabled: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 40)),
    onEvent: () => {},
  };
}

/** Records each event it receives, and when the code after `next()` in its `wrap` runs. */
function observer(order: string[]): VernLLMMiddleware {
  return {
    name: 'observer',
    priority: 10,
    wrap: async (_request, next) => {
      const result = await next();
      order.push('wrap:after');
      return result;
    },
    onEvent: (event) => {
      order.push(`event:${event.kind}`);
    },
  };
}

describe('middleware onEvent delivery relative to the call path', () => {
  it('delivers usage before the code after next() on a plain success', async () => {
    const { client } = createMockClient([withUsage('ok')]);
    const order: string[] = [];

    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [slowGate(), observer(order)],
    });

    await llm.call(CALL);

    expect(order).toEqual(['event:usage', 'wrap:after']);
  });

  it('delivers retry and then usage before the code after next()', async () => {
    const { client } = createMockClient([new FakeApiError('temporary', 500), withUsage('ok')]);
    const order: string[] = [];

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 1,
      baseDelayMs: 1,
      middleware: [slowGate(), observer(order)],
    });

    await llm.call(CALL);

    expect(order).toEqual(['event:retry', 'event:usage', 'wrap:after']);
  });

  it('delivers fallback and then usage before the code after next()', async () => {
    const chain = fallbackChain([new FakeApiError('down', 500)], [withUsage('from fallback')]);
    const order: string[] = [];

    const llm = new VernLLM({ ...chain.options, middleware: [slowGate(), observer(order)] });

    await llm.call(CALL);

    expect(order).toEqual(['event:fallback', 'event:usage', 'wrap:after']);
  });

  it('delivers usage before finalResult settles on a stream', async () => {
    const { client } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'hello' },
        { type: 'usage', usage: USAGE },
      ],
    ]);
    const order: string[] = [];

    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [slowGate(), observer(order)],
    });

    const { finalResult } = await llm.call({ ...CALL, stream: true });
    await finalResult;
    order.push('finalResult');

    // wrap resumes once the stream has opened. Usage arrives with the stream and is delivered
    // before finalResult settles.
    expect(order).toEqual(['wrap:after', 'event:usage', 'finalResult']);
  });

  it('lets a handler start another call on the same instance without deadlocking', async () => {
    const { client } = createMockClient([withUsage('ok')]);
    let inner: Promise<unknown> | undefined;

    const llm: VernLLM = new VernLLM({
      client,
      model: 'test-model',
      middleware: [
        {
          name: 'reentrant',
          onEvent: (event) => {
            if (event.kind === 'usage' && inner === undefined) {
              inner = llm.call({ userContent: 'inner', jsonMode: false });
            }
          },
        },
      ],
    });

    await expect(llm.call({ userContent: 'outer', jsonMode: false })).resolves.toBe('ok');
    await expect(inner).resolves.toBe('ok');
  });
});
