import { describe, it, expect, vi } from 'vitest';

import { CircuitBreaker } from '../../../../src/circuitBreaker.js';
import {
  CallExecutor,
  type CallExecutorOptions,
} from '../../../../src/internal/execution/callExecutor.js';
import { LLMError } from '../../../../src/types/errors.js';
import { createMockClient, jsonResponse } from '../../../helpers.js';

import type { Logger } from '../../../../src/logger.js';

function silentLogger(): Logger {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function baseOptions(overrides: Partial<CallExecutorOptions> = {}): CallExecutorOptions {
  return {
    maxRetries: 1,
    timeoutMs: 25_000,
    chunkIdleTimeoutMs: 30_000,
    baseDelayMs: 500,
    defaultMaxTokens: 1000,
    defaultTemperature: 0.2,
    nonRetryableStatus: [400, 401, 403, 404, 422],
    logger: silentLogger(),
    ...overrides,
  };
}

describe('CallExecutor.previewRequest', () => {
  it('builds the wire request for the given params without dispatching it', async () => {
    const { client, create } = createMockClient([jsonResponse({ ok: true })]);
    const executor = new CallExecutor('openai', client, 'gpt-test', baseOptions());

    const { model, request } = executor.previewRequest({ userContent: 'hi' });

    expect(model).toBe('gpt-test');
    expect(request.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(create).not.toHaveBeenCalled();
  });

  it('reflects a per-call model override in the preview', () => {
    const { client } = createMockClient([]);
    const executor = new CallExecutor('openai', client, 'gpt-test', baseOptions());

    const { model, request } = executor.previewRequest({
      userContent: 'hi',
      model: 'gpt-override',
    });

    expect(model).toBe('gpt-override');
    expect(request.model).toBe('gpt-override');
  });
});

describe('CallExecutor.jsonObjectModeSupported', () => {
  it('defaults to true when the client omits supportsJsonObjectMode', () => {
    const { client } = createMockClient([]);
    const executor = new CallExecutor('openai', client, 'm', baseOptions());

    expect(executor.jsonObjectModeSupported).toBe(true);
  });

  it("reflects the client's own supportsJsonObjectMode: false", () => {
    const { client } = createMockClient([]);
    client.supportsJsonObjectMode = false;
    const executor = new CallExecutor('openai', client, 'm', baseOptions());

    expect(executor.jsonObjectModeSupported).toBe(false);
  });
});

describe('CallExecutor.isolateByModel', () => {
  it('is false when no breaker is configured', () => {
    const { client } = createMockClient([]);
    const executor = new CallExecutor('openai', client, 'm', baseOptions());

    expect(executor.isolateByModel).toBe(false);
  });

  it("reflects the configured breaker's isolateByModel option", () => {
    const { client } = createMockClient([]);
    const breaker = new CircuitBreaker({ isolateByModel: true });
    const executor = new CallExecutor('openai', client, 'm', baseOptions({ breaker }));

    expect(executor.isolateByModel).toBe(true);
  });
});

describe('CallExecutor.getCircuitState', () => {
  it('returns undefined when no breaker is configured', () => {
    const { client } = createMockClient([]);
    const executor = new CallExecutor('openai', client, 'm', baseOptions());

    expect(executor.getCircuitState()).toBeUndefined();
  });

  it("delegates to the configured breaker's getState", () => {
    const { client } = createMockClient([]);
    const breaker = new CircuitBreaker();
    const executor = new CallExecutor('openai', client, 'm', baseOptions({ breaker }));

    expect(executor.getCircuitState()).toBe('closed');
  });
});

describe('CallExecutor.assertBreakerClosed', () => {
  it('is a no-op when no breaker is configured', () => {
    const { client } = createMockClient([]);
    const executor = new CallExecutor('openai', client, 'm', baseOptions());

    expect(() => executor.assertBreakerClosed()).not.toThrow();
  });

  it('throws a circuit_open LLMError once the configured breaker is open', () => {
    const { client } = createMockClient([]);
    const breaker = new CircuitBreaker({ threshold: 1 });
    const executor = new CallExecutor('openai', client, 'm', baseOptions({ breaker }));

    breaker.open('m');

    expect(() => executor.assertBreakerClosed('m')).toThrow(LLMError);
    try {
      executor.assertBreakerClosed('m');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMError);
      if (error instanceof LLMError) expect(error.type).toBe('circuit_open');
    }
  });

  it("falls back to the executor's own model when no model is given", () => {
    const { client } = createMockClient([]);
    const breaker = new CircuitBreaker({ threshold: 1, isolateByModel: true });
    const executor = new CallExecutor('openai', client, 'default-model', baseOptions({ breaker }));

    breaker.open('default-model');

    expect(() => executor.assertBreakerClosed()).toThrow(LLMError);
  });
});

describe('CallExecutor.openCircuit / closeCircuit', () => {
  it('is a no-op when no breaker is configured', () => {
    const { client } = createMockClient([]);
    const executor = new CallExecutor('openai', client, 'm', baseOptions());

    expect(() => executor.openCircuit()).not.toThrow();
    expect(() => executor.closeCircuit()).not.toThrow();
  });

  it('openCircuit manually opens the configured breaker without any real failures', () => {
    const { client } = createMockClient([]);
    const breaker = new CircuitBreaker();
    const executor = new CallExecutor('openai', client, 'm', baseOptions({ breaker }));

    expect(executor.getCircuitState()).toBe('closed');
    executor.openCircuit();
    expect(executor.getCircuitState()).toBe('open');
  });

  it('closeCircuit manually closes an open breaker', () => {
    const { client } = createMockClient([]);
    const breaker = new CircuitBreaker();
    const executor = new CallExecutor('openai', client, 'm', baseOptions({ breaker }));

    executor.openCircuit();
    expect(executor.getCircuitState()).toBe('open');

    executor.closeCircuit();
    expect(executor.getCircuitState()).toBe('closed');
  });

  it('openCircuit/closeCircuit target a specific model when given one', () => {
    const { client } = createMockClient([]);
    const breaker = new CircuitBreaker({ isolateByModel: true });
    const executor = new CallExecutor('openai', client, 'm', baseOptions({ breaker }));

    executor.openCircuit('model-a');

    expect(executor.getCircuitState('model-a')).toBe('open');
    expect(executor.getCircuitState('model-b')).toBe('closed');
  });
});

describe('CallExecutor.countsTowardBreaker (via run/breaker state transitions)', () => {
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
});
