import { describe, expect, it } from 'vitest';

import { type VernLLMEvent, type VernLLMMiddleware } from '../../../src/types/index.js';
import { VernLLM } from '../../../src/vernLLM.js';
import {
  createMockClient,
  createMockStreamingClient,
  FakeApiError,
  textResponse,
} from '../../helpers.js';
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

describe('events from a chain started with next.again()', () => {
  const rerunner: VernLLMMiddleware = {
    name: 'rerunner',
    priority: 1,
    reruns: true,
    wrap: async (_request, next) => {
      const first = await next();
      await next.again!().catch(() => {});

      return first;
    },
  };

  const collect = () => {
    const events: VernLLMEvent[] = [];
    return { events, onEvent: (event: VernLLMEvent) => void events.push(event) };
  };

  const chainsOf = (events: VernLLMEvent[], kind: VernLLMEvent['kind']) =>
    events.filter((event) => event.kind === kind).map((event) => event.chain);

  it('stamps chain on retry events and keeps one stream for the call', async () => {
    const { client } = createMockClient([
      textResponse('first'),
      new FakeApiError('hiccup', 500),
      textResponse('second'),
    ]);
    const { events, onEvent } = collect();
    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 1,
      baseDelayMs: 1,
      logger: 'silent',
      middleware: [rerunner],
      onEvent,
    });

    await llm.call(CALL);

    expect(chainsOf(events, 'retry')).toEqual([1]);
    expect(
      new Set(events.flatMap((event) => ('requestId' in event ? [event.requestId] : []))).size,
    ).toBe(1);
  });

  it('stamps chain on fallback events', async () => {
    const chain = fallbackChain(
      [textResponse('first'), new FakeApiError('down', 500)],
      [textResponse('from fallback')],
    );
    const { events, onEvent } = collect();
    const llm = new VernLLM({ ...chain.options, middleware: [rerunner], onEvent });

    await llm.call(CALL);

    expect(chainsOf(events, 'fallback')).toEqual([1]);
  });

  it('stamps chain on usage events', async () => {
    const { client } = createMockClient([withUsage('first'), withUsage('second')]);
    const { events, onEvent } = collect();
    const llm = new VernLLM({ client, model: 'test-model', middleware: [rerunner], onEvent });

    await llm.call(CALL);

    expect(chainsOf(events, 'usage')).toEqual([undefined, 1]);
  });

  it('stamps chain on usage_failure events', async () => {
    const { client } = createMockClient([
      { choices: [{ message: { content: '{"a":1}' } }], usage: USAGE },
      { choices: [{ message: { content: 'not json' } }], usage: USAGE },
    ]);
    const { events, onEvent } = collect();
    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      logger: 'silent',
      middleware: [rerunner],
      onEvent,
    });

    await llm.call({ userContent: 'hi', jsonMode: true });

    expect(chainsOf(events, 'usage_failure')).toEqual([1]);
  });

  it('stamps chain on middleware events', async () => {
    const { client } = createMockClient([textResponse('first'), textResponse('second')]);
    const { events, onEvent } = collect();
    const skipsRerun: VernLLMMiddleware = {
      name: 'skips-rerun',
      priority: 2,
      enabled: (ctx) => ctx.chain === undefined,
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [rerunner, skipsRerun],
      onEvent,
    });

    await llm.call(CALL);

    const skips = events.filter(
      (event) => event.kind === 'middleware' && event.hook === 'enabled_skip',
    );

    // `enabled` is checked at the wrap stage and again for the attempt, both inside the rerun.
    expect(skips.length).toBeGreaterThan(0);
    expect(skips.every((event) => event.chain === 1)).toBe(true);
  });

  it('stamps chain on custom events', async () => {
    const { client } = createMockClient([textResponse('first'), textResponse('second')]);
    const { events, onEvent } = collect();
    const emitter: VernLLMMiddleware = {
      name: 'emitter',
      priority: 2,
      transform: (_request, ctx) => {
        ctx.emit('test.attempt', { chain: ctx.chain ?? 0 });
        return {};
      },
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [rerunner, emitter],
      onEvent,
    });

    await llm.call(CALL);

    expect(chainsOf(events, 'custom')).toEqual([undefined, 1]);
  });
});
