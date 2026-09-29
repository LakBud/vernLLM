import { describe, expect, it } from 'vitest';

import { type LLMError } from '../../../src/types/errors.js';
import { type AttemptContext, type VernLLMMiddleware } from '../../../src/types/index.js';
import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, FakeApiError, textResponse } from '../../helpers.js';
import { CALL } from './middleware.int.helpers.js';

describe('middleware dispatch', () => {
  it('runs once per real attempt across retries and fallback, nested inside wrap, after transform', async () => {
    const { client: primary, calls: primaryCalls } = createMockClient([
      new FakeApiError('down', 500),
      new FakeApiError('still down', 500),
    ]);
    const { client: fallback } = createMockClient([textResponse('from fallback')]);
    primary.adapter = { name: 'openai-compatible', provider: 'openai' };
    const trace: string[] = [];
    const contexts: AttemptContext[] = [];

    const observer: VernLLMMiddleware = {
      name: 'observer',
      transform: (_request, ctx) => {
        trace.push(`transform:${ctx.requestedProvider}:${ctx.attempt}`);
        return {};
      },
      wrap: async (_request, next) => {
        trace.push('wrap:start');
        const result = await next();
        trace.push('wrap:end');
        return result;
      },
      dispatch: async (_request, next, ctx) => {
        contexts.push(ctx);
        trace.push(`dispatch:${ctx.requestedProvider}:${ctx.attempt}`);
        try {
          await next();
          trace.push('dispatch:ok');
        } catch (error) {
          trace.push(`dispatch:failed:${(error as LLMError).status}`);
          throw error;
        }
      },
    };

    const llm = new VernLLM({
      client: primary,
      model: 'primary-model',
      maxRetries: 1,
      baseDelayMs: 1,
      logger: 'silent',
      fallback: { client: fallback, model: 'fallback-model', name: 'backup' },
      middleware: [observer],
    });

    await expect(llm.call(CALL)).resolves.toBe('from fallback');

    expect(primaryCalls).toHaveLength(2);
    expect(trace).toEqual([
      'wrap:start',
      'transform:primary:1',
      'dispatch:primary:1',
      'dispatch:failed:500',
      'transform:primary:2',
      'dispatch:primary:2',
      'dispatch:failed:500',
      'transform:backup:1',
      'dispatch:backup:1',
      'dispatch:ok',
      'wrap:end',
    ]);
    expect(contexts.map((ctx) => ctx.adapter)).toEqual([
      { name: 'openai-compatible', provider: 'openai' },
      { name: 'openai-compatible', provider: 'openai' },
      { name: 'custom' },
    ]);
    expect(contexts.map((ctx) => ctx.isFallbackAttempt)).toEqual([false, false, true]);
  });

  it('a dispatch that never calls next fails the call before any real request, and never counts toward the breaker', async () => {
    const { client, create } = createMockClient([textResponse('never')]);
    const { client: fallback, create: fallbackCreate } = createMockClient([textResponse('never')]);

    const llm = new VernLLM({
      client,
      model: 'test-model',
      maxRetries: 2,
      circuitBreaker: { threshold: 1 },
      logger: 'silent',
      fallback: { client: fallback, model: 'fallback-model' },
      middleware: [{ name: 'skipper', dispatch: async () => {} }],
    });

    await expect(llm.call(CALL)).rejects.toMatchObject({
      type: 'invalid_params',
      code: 'middleware_threw',
    });

    expect(create).not.toHaveBeenCalled();
    expect(fallbackCreate).not.toHaveBeenCalled();
    expect(llm.getCircuitState()).toBe('closed');
  });
});
