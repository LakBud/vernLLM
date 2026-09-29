import { describe, expect, it, vi } from 'vitest';

import { LLMError } from '../../../src/types/errors.js';
import { FallbackExhaustedError } from '../../../src/types/fallback.js';
import { type VernLLMMiddleware } from '../../../src/types/index.js';
import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, textResponse } from '../../helpers.js';
import { CALL, fallbackChain } from './middleware.int.helpers.js';

describe('middleware failures', () => {
  it('a transform rejecting a bad request with invalid_params stops the real request from going out', async () => {
    const { client, create } = createMockClient([textResponse('should never be reached')]);

    const guard: VernLLMMiddleware = {
      name: 'guard',
      transform: (request) => {
        const hasSecret = request.messages.some(
          (message) => typeof message.content === 'string' && message.content.includes('SECRET'),
        );
        if (hasSecret) throw new LLMError('blocked: message contains a secret', 'invalid_params');
        return {};
      },
    };

    const llm = new VernLLM({ client, model: 'test-model', middleware: [guard] });

    await expect(
      llm.call({ userContent: 'here is a SECRET value', jsonMode: false }),
    ).rejects.toMatchObject({ type: 'invalid_params' });

    expect(create).not.toHaveBeenCalled();
  });

  it('a plain bug thrown by a middleware fails fast, is never retried, and never counts toward the breaker', async () => {
    const { client, create } = createMockClient([textResponse('would have worked')]);
    let transformRuns = 0;

    const buggy: VernLLMMiddleware = {
      name: 'buggy',
      transform: () => {
        transformRuns++;
        throw new Error('undefined is not a function');
      },
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 3,
      baseDelayMs: 1,
      logger: 'silent',
      middleware: [buggy],
      circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
    });

    // Far past the single failure that would open a breaker counting real provider failures.
    for (let call = 0; call < 5; call++) {
      await expect(llm.call(CALL)).rejects.toMatchObject({
        type: 'invalid_params',
        code: 'middleware_threw',
      });
    }

    // One transform run per call: a deterministic bug is excluded from retry.
    expect(transformRuns).toBe(5);
    expect(create).not.toHaveBeenCalled();
    expect(llm.getCircuitState()).toBe('closed');
  });

  it('duplicate tool names added by two middleware stop the chain on the first target, naming the offender', async () => {
    const chain = fallbackChain([textResponse('unused')], [textResponse('unused')]);
    const addSharedTool = (name: string, priority: number): VernLLMMiddleware => ({
      name,
      priority,
      transform: () => ({
        addTools: [
          { type: 'function', function: { name: 'shared', description: name, parameters: {} } },
        ],
      }),
    });

    const llm = new VernLLM({
      ...chain.options,
      middleware: [addSharedTool('tool-a', 0), addSharedTool('tool-b', 1)],
    });

    const outcome = await llm.call(CALL).catch((error: unknown) => error);

    // Caller input is rejected the same way on every target, so the chain stops instead of
    // repeating it on the fallback.
    expect(outcome).toBeInstanceOf(LLMError);
    expect(outcome).not.toBeInstanceOf(FallbackExhaustedError);
    expect(outcome).toMatchObject({ type: 'invalid_params', code: 'duplicate_tool_names' });
    expect((outcome as LLMError).message).toContain('tool-b');
    expect(chain.primary.create).not.toHaveBeenCalled();
    expect(chain.fallback.create).not.toHaveBeenCalled();
  });

  it('a slow enabled() times out per middlewareTimeoutMs and the middleware is treated as disabled', async () => {
    const { client, calls } = createMockClient([textResponse('hi')]);
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const slow: VernLLMMiddleware = {
      name: 'slow-flag-check',
      enabled: () => new Promise(() => {}),
      transform: () => ({ addMessages: [{ role: 'user', content: 'should never appear' }] }),
    };

    const llm = new VernLLM({
      client,
      model: 'test-model',
      middleware: [slow],
      middlewareTimeoutMs: 20,
      logger,
    });

    await expect(llm.call(CALL)).resolves.toBe('hi');

    expect(calls[0]!.messages.some((message) => message.content === 'should never appear')).toBe(
      false,
    );
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] middleware "slow-flag-check".enabled threw or timed out, treating as disabled',
      expect.objectContaining({ message: expect.any(String) }),
    );
  });
});
