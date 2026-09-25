import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, FakeApiError, jsonResponse } from '../../helpers.js';

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

    // A large baseDelayMs means a second attempt, if it happened, would
    // only fire long after the short deadline below, so a call that
    // still rejects with deadline_exceeded (rather than eventually
    // resolving) demonstrates the deadline actually stopped the loop
    // mid backoff, not merely raced it.
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
