import { describe, expect, it, vi } from 'vitest';

import {
  createStateKey,
  type VernLLMEvent,
  type VernLLMMiddleware,
} from '../../../src/types/index.js';
import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, FakeApiError, textResponse } from '../../helpers.js';
import { CALL } from './middleware.int.helpers.js';

type Custom = Extract<VernLLMEvent, { kind: 'custom' }>;

const customOnly = (events: VernLLMEvent[]): Custom[] =>
  events.filter((event): event is Custom => event.kind === 'custom');

const spyLogger = () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('middleware ctx.emit', () => {
  it('reaches onEvent and every middleware from wrap, transform and dispatch, labelled with the emitter', async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const instanceEvents: VernLLMEvent[] = [];
    const listenerEvents: VernLLMEvent[] = [];

    const emitter: VernLLMMiddleware = {
      name: 'emitter',
      wrap: async (_request, next, ctx) => {
        ctx.emit('phase', { hook: 'wrap' });
        return next();
      },
      transform: (_request, ctx) => {
        ctx.emit('phase', { hook: 'transform', attempt: ctx.attempt });
        return {};
      },
      dispatch: async (_request, next, ctx) => {
        ctx.emit('phase', { hook: 'dispatch' });
        await next();
      },
    };
    const listener: VernLLMMiddleware = {
      name: 'listener',
      onEvent: (event) => void listenerEvents.push(event),
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [emitter, listener],
      onEvent: (event) => void instanceEvents.push(event),
      logger: 'silent',
    });

    await llm.call({ ...CALL, requestId: 'req-int' });

    const phase = (data: Custom['data']): Custom => ({
      kind: 'custom',
      requestId: 'req-int',
      name: 'phase',
      source: 'emitter',
      data,
    });
    const expected = [
      phase({ hook: 'wrap' }),
      phase({ hook: 'transform', attempt: 1 }),
      phase({ hook: 'dispatch' }),
    ];

    expect(customOnly(instanceEvents)).toEqual(expected);
    expect(customOnly(listenerEvents)).toEqual(expected);
  });

  it('emits again on every attempt of a real retry, from the same middleware', async () => {
    const { client } = createMockClient([new FakeApiError('temporary', 500), textResponse('ok')]);
    const events: VernLLMEvent[] = [];

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 1,
      baseDelayMs: 1,
      logger: 'silent',
      onEvent: (event) => void events.push(event),
      middleware: [
        {
          name: 'per-attempt',
          transform: (_request, ctx) => {
            ctx.emit('attempt', { attempt: ctx.attempt });
            return {};
          },
        },
      ],
    });

    await llm.call(CALL);

    expect(customOnly(events).map((event) => event.data)).toEqual([{ attempt: 1 }, { attempt: 2 }]);
  });

  it("gives a listener's ctx the same state bag as the emitter, so a decision can travel both ways", async () => {
    const { client } = createMockClient([textResponse('ok')]);
    const decisionKey = createStateKey<string>('test.decision');
    const seen: string[] = [];

    const llm = new VernLLM({
      client,
      model: 'test-model',
      logger: 'silent',
      middleware: [
        {
          name: 'router',
          wrap: async (_request, next, ctx) => {
            ctx.state.set(decisionKey, 'claude');
            ctx.emit('router.decision', { deployment: 'claude' });
            return next();
          },
        },
        {
          name: 'audit',
          onEvent: (event, ctx) => {
            if (event.kind === 'custom') seen.push(`${event.name}:${ctx.state.get(decisionKey)}`);
          },
        },
      ],
    });

    await llm.call(CALL);

    expect(seen).toEqual(['router.decision:claude']);
  });

  it('does not loop when a handler emits from onEvent, and the call still succeeds', async () => {
    const { client } = createMockClient([textResponse('answer')]);
    const logger = spyLogger();
    let handled = 0;

    const llm = new VernLLM({
      client,
      model: 'test-model',
      logger,
      middleware: [
        {
          name: 'echo',
          wrap: async (_request, next, ctx) => {
            ctx.emit('first');
            return next();
          },
          onEvent: (event, ctx) => {
            if (event.kind !== 'custom') return;
            handled++;
            ctx.emit('echo');
          },
        },
      ],
    });

    await expect(llm.call(CALL)).resolves.toBe('answer');

    expect(handled).toBe(1);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^\[VernLLM:[^\]]+\] middleware "echo" emitted "echo" while /),
    );
  });

  it('never changes the call outcome when a middleware emits invalid data', async () => {
    const { client } = createMockClient([textResponse('answer')]);
    const logger = spyLogger();
    const events: VernLLMEvent[] = [];

    const llm = new VernLLM({
      client,
      model: 'test-model',
      logger,
      onEvent: (event) => void events.push(event),
      middleware: [
        {
          name: 'sloppy',
          wrap: async (_request, next, ctx) => {
            ctx.emit('bad', { value: Number.NaN });
            ctx.emit('', { value: 1 });
            return next();
          },
        },
      ],
    });

    await expect(llm.call(CALL)).resolves.toBe('answer');

    expect(customOnly(events)).toEqual([]);
    // Both invalid emits share one warning per call.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
