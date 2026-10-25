import { describe, expect, it, vi } from 'vitest';

import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, FakeApiError, textResponse } from '../../helpers.js';
import { CALL, heldResponse, raceTwo, withUsage } from './middleware.int.helpers.js';

import type { VernLLMEvent, VernLLMMiddleware } from '../../../src/types/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('chains end with the wrap', () => {
  it('cancels a loser still waiting on the provider once the winner is returned', async () => {
    const held = heldResponse('slow');
    const { client } = createMockClient([held.entry, textResponse('fast')]);
    const llm = new VernLLM({ client, model: 'test-model', middleware: [raceTwo()] });

    await expect(llm.call(CALL)).resolves.toBe('fast');

    expect(held.aborted()).toBe(true);
  });

  it('cancels the main chain even when the wrap forgets about it', async () => {
    const held = heldResponse('slow');
    const { client } = createMockClient([held.entry, textResponse('again')]);
    const forgetful: VernLLMMiddleware = {
      name: 'forgetful',
      reruns: true,
      wrap: async (_request, next) => {
        const main = next();
        main.catch(() => {});

        return next.again!();
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [forgetful] });

    await expect(llm.call(CALL)).resolves.toBe('again');

    expect(held.aborted()).toBe(true);
  });

  it('cancels the unfinished chain when the wrap throws while it is pending', async () => {
    const held = heldResponse('slow');
    const { client } = createMockClient([held.entry]);
    const giveUp: VernLLMMiddleware = {
      name: 'give-up',
      reruns: true,
      wrap: async (_request, next) => {
        next().catch(() => {});
        await sleep(10);

        throw new Error('gave up');
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [giveUp] });

    await expect(llm.call(CALL)).rejects.toMatchObject({ code: 'middleware_threw' });

    expect(held.aborted()).toBe(true);
  });

  it('cancels every chain when the call is aborted', async () => {
    const first = heldResponse('a');
    const second = heldResponse('b');
    const { client } = createMockClient([first.entry, second.entry]);
    const controller = new AbortController();
    const llm = new VernLLM({ client, model: 'test-model', middleware: [raceTwo()] });

    const call = llm.call({ ...CALL, signal: controller.signal });
    call.catch(() => {});

    await sleep(10);
    controller.abort();

    await expect(call).rejects.toBeDefined();
    expect(first.aborted()).toBe(true);
    expect(second.aborted()).toBe(true);
  });

  it('cancels every chain when the deadline runs out', async () => {
    const first = heldResponse('a');
    const second = heldResponse('b');
    const { client } = createMockClient([first.entry, second.entry]);
    const llm = new VernLLM({ client, model: 'test-model', middleware: [raceTwo()] });

    await expect(llm.call({ ...CALL, deadlineMs: 30 })).rejects.toBeDefined();

    expect(first.aborted()).toBe(true);
    expect(second.aborted()).toBe(true);
  });
});

describe('cancelled chains and circuit breakers', () => {
  it('never counts a cancelled chain toward the breaker', async () => {
    const held = heldResponse('slow');
    const { client } = createMockClient([held.entry, textResponse('fast')]);
    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 1000 },
      middleware: [raceTwo()],
    });

    await expect(llm.call(CALL)).resolves.toBe('fast');

    expect(held.aborted()).toBe(true);
    expect(llm.getCircuitStates()[0]?.state).toBe('closed');
  });

  it('releases a half open trial held by a chain that is then cancelled', async () => {
    const held = heldResponse('slow');
    const { client } = createMockClient([
      new FakeApiError('down', 500),
      held.entry,
      textResponse('ok'),
    ]);
    let abandon = false;

    const middleware: VernLLMMiddleware = {
      name: 'abandon',
      reruns: true,
      wrap: async (_request, next) => {
        if (!abandon) return next();

        next().catch(() => {});
        await sleep(10);

        throw new Error('gave up');
      },
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 0,
      logger: 'silent',
      circuitBreaker: { threshold: 1, cooldownMs: 40 },
      middleware: [middleware],
    });

    await expect(llm.call(CALL)).rejects.toBeDefined();
    expect(llm.getCircuitStates()[0]?.state).toBe('open');

    await sleep(60);
    abandon = true;
    await expect(llm.call(CALL)).rejects.toBeDefined();

    expect(held.aborted()).toBe(true);
    expect(llm.getCircuitStates()[0]?.state).toBe('half-open');

    abandon = false;
    // The cancelled attempt gives the trial slot back as its abort settles, a few ticks later.
    await sleep(50);
    await expect(llm.call(CALL)).resolves.toBe('ok');
    expect(llm.getCircuitStates()[0]?.state).toBe('closed');
  });
});

describe('usage per chain', () => {
  const usageEvents = (events: VernLLMEvent[]) => events.filter((event) => event.kind === 'usage');

  it('reports one usage event for each chain that got a response, with its chain', async () => {
    const { client } = createMockClient([withUsage('first'), withUsage('second')]);
    const events: VernLLMEvent[] = [];
    const sequential: VernLLMMiddleware = {
      name: 'sequential',
      reruns: true,
      wrap: async (_request, next) => {
        await next();
        return next.again!();
      },
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [sequential],
      onEvent: (event) => events.push(event),
    });

    await llm.call(CALL);

    expect(usageEvents(events).map((event) => event.chain)).toEqual([undefined, 1]);
  });

  it('reports nothing for a chain cancelled before its response', async () => {
    const held = heldResponse('slow');
    const { client } = createMockClient([held.entry, withUsage('fast')]);
    const events: VernLLMEvent[] = [];
    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [raceTwo()],
      onEvent: (event) => events.push(event),
    });

    await llm.call(CALL);

    expect(usageEvents(events).map((event) => event.chain)).toEqual([1]);
  });
});

describe('reservation per chain', () => {
  it('reserves for each chain, refunds the cancelled loser, and keeps the winner reserved', async () => {
    const held = heldResponse('slow');
    const { client } = createMockClient([held.entry, textResponse('fast')]);
    const reserveUsage = vi.fn(async () => {});
    const refundUsage = vi.fn(async () => {});
    const llm = new VernLLM({ client, model: 'test-model', middleware: [raceTwo()] });

    await llm.call({ ...CALL, reserveUsage, refundUsage });
    await vi.waitFor(() => expect(refundUsage).toHaveBeenCalledTimes(1));

    expect(reserveUsage).toHaveBeenCalledTimes(2);
  });

  it('fails only the rerun whose reserve throws', async () => {
    const { client } = createMockClient([textResponse('first'), textResponse('second')]);
    const reserveUsage = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('over budget'));
    const refundUsage = vi.fn(async () => {});
    let rerunError: unknown;
    const middleware: VernLLMMiddleware = {
      name: 'tolerant',
      reruns: true,
      wrap: async (_request, next) => {
        const first = await next();
        await next.again!().catch((error: unknown) => {
          rerunError = error;
        });

        return first;
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [middleware] });

    await expect(llm.call({ ...CALL, reserveUsage, refundUsage })).resolves.toBe('first');

    expect(rerunError).toMatchObject({ type: 'quota_exceeded' });
    expect(reserveUsage).toHaveBeenCalledTimes(2);
  });
});
