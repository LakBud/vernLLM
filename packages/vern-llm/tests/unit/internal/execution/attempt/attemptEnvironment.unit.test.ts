import { describe, it, expect, vi } from 'vitest';

import { CircuitBreaker } from '../../../../../src/circuitBreaker.js';
import {
  CallExecutor,
  type CallExecutorOptions,
} from '../../../../../src/internal/execution/callExecutor.js';
import { LLMError } from '../../../../../src/types/errors.js';
import {
  createMockClient,
  createMockStreamingClient,
  drain,
  jsonResponse,
} from '../../../../helpers.js';

import type { Logger } from '../../../../../src/logger.js';

function silentLogger(): Logger {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function baseOptions(overrides: Partial<CallExecutorOptions> = {}): CallExecutorOptions {
  return {
    maxRetries: 1,
    timeoutMs: 25_000,
    chunkIdleTimeoutMs: 30_000,
    baseDelayMs: 500,
    maxRetryAfterMs: 10_000,
    defaultMaxTokens: 1000,
    defaultTemperature: 0.2,
    nonRetryableStatus: [400, 401, 403, 404, 422],
    logger: silentLogger(),
    ...overrides,
  };
}

describe('countsTowardBreaker (via CallExecutor run/breaker state transitions)', () => {
  it('a validation-type failure (non-retryable) does not push the breaker toward opening', async () => {
    const { client } = createMockClient([new LLMError('bad request', 'validation')]);
    const breaker = new CircuitBreaker({ threshold: 1 });
    const executor = new CallExecutor(
      'openai',
      client,
      'm',
      baseOptions({ breaker, maxRetries: 0 }),
    );

    await expect(executor.run({ userContent: 'hi' }, 'req-1')).rejects.toThrow();

    // threshold is 1, so if this counted, the breaker would now be open
    expect(executor.getCircuitState()).toBe('closed');
  });

  it('a retryable api-type failure does push the breaker toward opening', async () => {
    const apiError = Object.assign(new Error('server error'), { status: 500 });
    const { client } = createMockClient([apiError]);
    const breaker = new CircuitBreaker({ threshold: 1 });
    const executor = new CallExecutor(
      'openai',
      client,
      'm',
      baseOptions({ breaker, maxRetries: 0 }),
    );

    await expect(executor.run({ userContent: 'hi' }, 'req-1')).rejects.toThrow();

    expect(executor.getCircuitState()).toBe('open');
  });

  it('a successful call records success and keeps/returns the breaker to closed', async () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const breaker = new CircuitBreaker({ threshold: 1 });
    const executor = new CallExecutor('openai', client, 'm', baseOptions({ breaker }));

    await executor.run({ userContent: 'hi' }, 'req-1');

    expect(executor.getCircuitState()).toBe('closed');
  });

  it('a streaming finalize-time soft failure excluded from the breaker (e.g. a tool-contract code) does not push it toward opening', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'hi' }]]);
    const breaker = new CircuitBreaker({ threshold: 1 });
    const executor = new CallExecutor(
      'openai',
      client,
      'm',
      baseOptions({
        breaker,
        maxRetries: 0,
        // 'unexpected_tool_calls' is a tool-contract code, non-retryable
        // and therefore excluded from the breaker regardless of type.
        detectSoftFailure: () => 'unexpected_tool_calls',
      }),
    );

    const { chunks, finalResult } = await executor.runStream(
      { userContent: 'hi', jsonMode: false, stream: true },
      'req-1',
    );
    await drain(chunks);

    await expect(finalResult).rejects.toMatchObject({ code: 'unexpected_tool_calls' });
    // threshold is 1, so if this counted, the breaker would now be open
    expect(executor.getCircuitState()).toBe('closed');
  });
});
