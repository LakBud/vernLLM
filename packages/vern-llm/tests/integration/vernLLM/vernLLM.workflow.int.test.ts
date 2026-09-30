import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { FallbackExhaustedError } from '../../../src/types/fallback.js';
import { defaultFallbackOn, type CallMeta, type FallbackOn } from '../../../src/types/index.js';
import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, FakeApiError, jsonResponse, textResponse } from '../../helpers.js';
import { CALL, targetChain } from '../middleware/middleware.int.helpers.js';

describe('VernLLM workflow integration', () => {
  it('retries, parses JSON, validates schema, and reports usage', async () => {
    const onUsage = vi.fn();

    const { client, create } = createMockClient([
      new FakeApiError('temporary failure', 500),
      jsonResponse(
        { answer: 'hello' },
        {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      ),
    ]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 1,
      baseDelayMs: 1,
      onUsage,
    });

    const result = await llm.call({
      systemPrompt: 'Answer JSON',
      userContent: 'hello',
      schema: z.object({
        answer: z.string(),
      }),
    });

    expect(result).toEqual({
      answer: 'hello',
    });

    expect(create).toHaveBeenCalledTimes(2);

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        model: 'test-model',
      }),
    );
  });

  it('deadlineMs cuts a real retry loop short instead of letting it continue into a second attempt', async () => {
    const { client, create } = createMockClient([
      new FakeApiError('temporary failure', 500),
      jsonResponse({ answer: 'hello' }),
    ]);

    // Backoff uses full jitter, a random delay between 0 and the cap, so a
    // large baseDelayMs alone doesn't guarantee a long wait: a draw under
    // the deadline lets the retry run first. Pinning the draw at half the
    // cap (5s here) keeps the second attempt far past the short deadline,
    // so rejecting with deadline_exceeded shows the deadline stopped the
    // loop mid backoff rather than racing it.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    try {
      const llm = new VernLLM({
        client,
        model: 'test-model',
        maxRetries: 3,
        baseDelayMs: 60_000,
      });

      await expect(
        llm.call({
          systemPrompt: 'Answer JSON',
          userContent: 'hello',
          deadlineMs: 20,
        }),
      ).rejects.toMatchObject({ type: 'aborted', code: 'deadline_exceeded' });

      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      random.mockRestore();
    }
  });
});

describe('VernLLM retry clamping and truncated output', () => {
  it.each([-1, Number.NaN])(
    'still calls the provider once when maxRetries is %s, and warns',
    async (maxRetries) => {
      const { client, create } = createMockClient([jsonResponse({ answer: 'hello' })]);
      const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

      const llm = new VernLLM({ client, model: 'test-model', maxRetries, logger });

      await expect(llm.call({ userContent: 'hello' })).resolves.toEqual({ answer: 'hello' });
      expect(create).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        `[VernLLM] primary: maxRetries must be a non-negative whole number, got ${String(maxRetries)}. Using 0.`,
      );
    },
  );

  it('retries JSON that was cut off at max_tokens and returns the complete retry', async () => {
    const { client, create } = createMockClient([
      { choices: [{ message: { content: '{"answer": "hel' }, finish_reason: 'length' }] },
      jsonResponse({ answer: 'hello' }),
    ]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 1,
      baseDelayMs: 1,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    await expect(llm.call({ userContent: 'hello' })).resolves.toEqual({ answer: 'hello' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('surfaces response_truncated without opening the circuit once retries run out', async () => {
    const truncated = {
      choices: [{ message: { content: '{"answer": "hel' }, finish_reason: 'length' }],
    };
    const { client } = createMockClient([truncated, truncated]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 1,
      baseDelayMs: 1,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    await expect(llm.call({ userContent: 'hello' })).rejects.toMatchObject({
      type: 'parse',
      code: 'response_truncated',
    });
    expect(llm.getCircuitStates()[0]?.state).toBe('closed');
  });

  it('does not retry invalid JSON from a response that finished normally', async () => {
    const { client, create } = createMockClient([
      { choices: [{ message: { content: '{"answer": oops}' }, finish_reason: 'stop' }] },
    ]);

    const llm = new VernLLM({ client, model: 'test-model', maxRetries: 2, baseDelayMs: 1 });

    await expect(llm.call({ userContent: 'hello' })).rejects.toMatchObject({ type: 'parse' });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('VernLLM target order workflow', () => {
  it('tries the targets in the order the call names, reporting the position that answered', async () => {
    const order: string[] = [];
    const chain = targetChain(
      [
        () => {
          order.push('primary');
          return textResponse('from primary');
        },
      ],
      [
        () => {
          order.push('b');
          throw new FakeApiError('b down', 500);
        },
      ],
      [
        () => {
          order.push('c');
          throw new FakeApiError('c down', 500);
        },
      ],
    );
    const meta: { current?: CallMeta } = {};

    const llm = new VernLLM(chain.options);

    await expect(llm.call({ ...CALL, targets: ['c', 'b', 'primary'], meta })).resolves.toBe(
      'from primary',
    );

    expect(order).toEqual(['c', 'b', 'primary']);
    expect(meta.current).toEqual({
      provider: 'primary',
      model: 'primary-model',
      fallbackIndex: -1,
      usedFallback: false,
      attempts: 1,
      position: 2,
    });
  });

  it('runs every target as declared when the call names none', async () => {
    const chain = targetChain(
      [new FakeApiError('primary down', 500)],
      [textResponse('from b')],
      [textResponse('from c')],
    );
    const meta: { current?: CallMeta } = {};

    const llm = new VernLLM(chain.options);

    await expect(llm.call({ ...CALL, meta })).resolves.toBe('from b');
    expect(meta.current).toMatchObject({ provider: 'b', fallbackIndex: 0, position: 1 });
  });

  it('decides isLastTarget by position in the order, not by declared index', async () => {
    const fallbackOn = vi.fn().mockReturnValue('next');
    const chain = targetChain(
      [textResponse('unused')],
      [new FakeApiError('b down', 500)],
      [new FakeApiError('c down', 500)],
    );

    const llm = new VernLLM({ ...chain.options, fallbackOn });

    // `c` is the last declared target but the first tried, and `b` is the last tried.
    await expect(llm.call({ ...CALL, targets: ['c', 'b'] })).rejects.toBeInstanceOf(
      FallbackExhaustedError,
    );

    expect(fallbackOn.mock.calls.map(([, context]) => context.isLastTarget)).toEqual([false, true]);
    expect(chain.primary.create).not.toHaveBeenCalled();
  });

  it('tells fallbackOn the failed target and the next one, by declared index, in the order tried', async () => {
    const fallbackOn = vi.fn().mockReturnValue('next');
    const chain = targetChain(
      [textResponse('unused')],
      [textResponse('from b')],
      [new FakeApiError('c down', 500)],
    );

    const llm = new VernLLM({ ...chain.options, fallbackOn });

    await expect(llm.call({ ...CALL, targets: ['c', 'b'] })).resolves.toBe('from b');

    expect(fallbackOn).toHaveBeenCalledTimes(1);
    expect(fallbackOn.mock.calls[0]![1]).toEqual({
      isLastTarget: false,
      failed: { name: 'c', index: 2, model: 'c-model', adapter: { name: 'custom' } },
      next: { name: 'b', index: 1, model: 'b-model', adapter: { name: 'custom' } },
    });
  });

  it('leaves next out on the last target of the order, and still names the failed one', async () => {
    const fallbackOn = vi.fn().mockReturnValue('next');
    const chain = targetChain(
      [new FakeApiError('primary down', 500)],
      [textResponse('unused')],
      [textResponse('unused')],
    );

    const llm = new VernLLM({ ...chain.options, fallbackOn });

    await expect(llm.call({ ...CALL, targets: ['primary'] })).rejects.toMatchObject({
      type: 'api',
    });

    const context = fallbackOn.mock.calls[0]![1];
    expect(context).toMatchObject({ isLastTarget: true, failed: { name: 'primary', index: 0 } });
    expect(context).not.toHaveProperty('next');
  });

  it('lets fallbackOn stop on a model change, the case the target details exist for', async () => {
    const chain = targetChain(
      [new FakeApiError('primary down', 500)],
      [textResponse('unused')],
      [textResponse('unused')],
    );
    const fallbackOn: FallbackOn = (error, { failed, next }) =>
      next && next.model !== failed.model
        ? 'stop'
        : defaultFallbackOn(error, { isLastTarget: !next });

    const llm = new VernLLM({ ...chain.options, fallbackOn });

    await expect(llm.call(CALL)).rejects.toMatchObject({ type: 'api' });
    expect(chain.b.create).not.toHaveBeenCalled();
  });

  it('shows the per call model on the failed primary only', async () => {
    const fallbackOn = vi.fn().mockReturnValue('next');
    const chain = targetChain(
      [new FakeApiError('primary down', 500)],
      [textResponse('from b')],
      [textResponse('unused')],
    );

    const llm = new VernLLM({ ...chain.options, fallbackOn });

    await llm.call({ ...CALL, model: 'override-model' });

    const { failed, next } = fallbackOn.mock.calls[0]![1];
    expect(failed.model).toBe('override-model');
    expect(next.model).toBe('b-model');
  });

  it('throws the lone failure, not FallbackExhaustedError, for a call narrowed to one failing target', async () => {
    const chain = targetChain(
      [textResponse('unused')],
      [new FakeApiError('b down', 500)],
      [textResponse('unused')],
    );

    const llm = new VernLLM(chain.options);

    const error = await llm.call({ ...CALL, targets: ['b'] }).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(FallbackExhaustedError);
    expect(error).toMatchObject({ type: 'api', status: 500 });
    expect(chain.primary.create).not.toHaveBeenCalled();
    expect(chain.c.create).not.toHaveBeenCalled();
  });

  it('checks the breaker of a call narrowed to one target before reserving usage', async () => {
    const chain = targetChain(
      [textResponse('unused')],
      [textResponse('unused')],
      [textResponse('unused')],
    );
    const reserveUsage = vi.fn();
    const refundUsage = vi.fn();

    const llm = new VernLLM({
      ...chain.options,
      fallback: [
        { client: chain.b.client, model: 'b-model', name: 'b', circuitBreaker: { threshold: 1 } },
        { client: chain.c.client, model: 'c-model', name: 'c' },
      ],
    });
    llm.openCircuit({ index: 1 });

    await expect(
      llm.call({ ...CALL, targets: ['b'], reserveUsage, refundUsage }),
    ).rejects.toMatchObject({ type: 'circuit_open' });

    // With a longer order the check would sit inside the chain, after the reservation.
    expect(reserveUsage).not.toHaveBeenCalled();
    expect(refundUsage).not.toHaveBeenCalled();
    expect(chain.primary.create).not.toHaveBeenCalled();
    expect(chain.b.create).not.toHaveBeenCalled();
  });

  it('applies the per call model to the primary wherever it sits in the order, and to no other target', async () => {
    const chain = targetChain(
      [textResponse('from primary')],
      [new FakeApiError('b down', 500)],
      [textResponse('from c')],
    );

    const llm = new VernLLM(chain.options);

    await llm.call({ ...CALL, model: 'override-model', targets: ['b', 'primary'] });
    await llm.call({ ...CALL, model: 'override-model', targets: ['c'] });

    expect(chain.b.calls[0]?.model).toBe('b-model');
    expect(chain.primary.calls[0]?.model).toBe('override-model');
    // A sole fallback target runs its own model, since the override names a primary model.
    expect(chain.c.calls[0]?.model).toBe('c-model');
  });

  it("checks a sole fallback target's own model bucket, not the per call model meant for the primary", async () => {
    const chain = targetChain([textResponse('u')], [textResponse('u')], [textResponse('from c')]);

    const llm = new VernLLM({
      ...chain.options,
      fallback: [
        { client: chain.b.client, model: 'b-model', name: 'b' },
        {
          client: chain.c.client,
          model: 'c-model',
          name: 'c',
          circuitBreaker: { threshold: 1, isolateByModel: true },
        },
      ],
    });
    llm.openCircuit({ index: 2, model: 'c-model' });

    // The override names a primary model. Checking its bucket would find it closed and let the call through.
    await expect(
      llm.call({ ...CALL, model: 'override-model', targets: ['c'] }),
    ).rejects.toMatchObject({ type: 'circuit_open' });
    expect(chain.c.create).not.toHaveBeenCalled();
  });

  it('leaves the per call model unused when the order leaves the primary out', async () => {
    const chain = targetChain(
      [textResponse('unused')],
      [textResponse('from b')],
      [textResponse('unused')],
    );

    const llm = new VernLLM(chain.options);

    await expect(llm.call({ ...CALL, model: 'override-model', targets: ['b'] })).resolves.toBe(
      'from b',
    );
    expect(chain.primary.create).not.toHaveBeenCalled();
    expect(chain.b.calls[0]?.model).toBe('b-model');
  });

  it.each([
    ['an unknown name', ['nope'], 'unknown_target'],
    ['an empty order', [], 'no_eligible_targets'],
    ['a repeated name', ['b', 'b'], 'no_eligible_targets'],
  ])(
    'rejects %s with its own code before any provider is contacted',
    async (_label, targets, code) => {
      const chain = targetChain(
        [textResponse('unused')],
        [textResponse('unused')],
        [textResponse('unused')],
      );

      const llm = new VernLLM(chain.options);

      await expect(llm.call({ ...CALL, targets })).rejects.toMatchObject({
        type: 'invalid_params',
        code,
        retryable: false,
      });
      expect(chain.primary.create).not.toHaveBeenCalled();
      expect(chain.b.create).not.toHaveBeenCalled();
      expect(chain.c.create).not.toHaveBeenCalled();
    },
  );

  it('lists the valid names in the unknown_target message', async () => {
    const chain = targetChain([textResponse('u')], [textResponse('u')], [textResponse('u')]);
    const llm = new VernLLM(chain.options);

    await expect(llm.call({ ...CALL, targets: ['nope'] })).rejects.toThrow(
      'Unknown target "nope". Valid targets: "primary", "b", "c"',
    );
  });
});
