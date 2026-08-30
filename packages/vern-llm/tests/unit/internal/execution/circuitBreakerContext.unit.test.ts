import { describe, expect, it, vi } from 'vitest';

import { CircuitBreaker } from '../../../../src/circuitBreaker.js';
import {
  createBreakerGateway,
  type BreakerGatewayOptions,
} from '../../../../src/internal/execution/circuitBreakerContext.js';
import { createMiddlewareStateBag } from '../../../../src/types/middleware.js';

function baseOptions(overrides: Partial<BreakerGatewayOptions> = {}): BreakerGatewayOptions {
  return {
    breaker: undefined,
    requestId: 'req-1',
    model: 'gpt-test',
    providerName: 'openai',
    isFallback: false,
    supportsJsonObjectMode: true,
    ...overrides,
  };
}

describe('createBreakerGateway, buildAttemptContext', () => {
  it('converts a 0-based attempt to the 1-based AttemptContext contract', () => {
    const gateway = createBreakerGateway(baseOptions());
    const state = createMiddlewareStateBag();

    expect(gateway.buildAttemptContext(0, undefined, state).attempt).toBe(1);
    expect(gateway.buildAttemptContext(1, undefined, state).attempt).toBe(2);
    expect(gateway.buildAttemptContext(4, undefined, state).attempt).toBe(5);
  });

  it('carries requestId, provider, model, fallback status, and capabilities through unchanged', () => {
    const gateway = createBreakerGateway(
      baseOptions({
        requestId: 'req-carried',
        model: 'claude-x',
        providerName: 'anthropic',
        isFallback: true,
        supportsJsonObjectMode: false,
      }),
    );
    const state = createMiddlewareStateBag();
    const signal = new AbortController().signal;

    const ctx = gateway.buildAttemptContext(0, signal, state);

    expect(ctx).toMatchObject({
      stage: 'attempt',
      requestId: 'req-carried',
      requestedProvider: 'anthropic',
      requestedModel: 'claude-x',
      isFallbackAttempt: true,
      capabilities: { supportsJsonObjectMode: false },
      signal,
      state,
    });
  });

  it('starts with an empty own bag on every call', () => {
    const gateway = createBreakerGateway(baseOptions());
    const state = createMiddlewareStateBag();

    expect(gateway.buildAttemptContext(0, undefined, state).own).toEqual({});
  });
});

describe('createBreakerGateway, buildCallContext', () => {
  it('converts a 0-based attempt to the 1-based CircuitBreakerCallContext contract', () => {
    const gateway = createBreakerGateway(baseOptions({ requestId: 'req-2' }));
    const state = createMiddlewareStateBag();
    const signal = new AbortController().signal;

    expect(gateway.buildCallContext(0, signal, state)).toEqual({
      requestId: 'req-2',
      state,
      signal,
      attempt: 1,
    });
    expect(gateway.buildCallContext(2, signal, state)).toMatchObject({ attempt: 3 });
  });
});

describe('createBreakerGateway, recordSuccess/recordFailure', () => {
  it('is a no-op when no breaker was configured', () => {
    const gateway = createBreakerGateway(baseOptions({ breaker: undefined }));
    const state = createMiddlewareStateBag();

    expect(() => gateway.recordSuccess(0, undefined, state)).not.toThrow();
    expect(() => gateway.recordFailure(0, undefined, state)).not.toThrow();
  });

  it('records success against the breaker with the resolved model and a 1-based attempt', () => {
    const breaker = new CircuitBreaker();
    const recordSuccess = vi.spyOn(breaker, 'recordSuccess');
    const gateway = createBreakerGateway(baseOptions({ breaker, model: 'gpt-success' }));
    const state = createMiddlewareStateBag();
    const signal = new AbortController().signal;

    gateway.recordSuccess(1, signal, state);

    expect(recordSuccess).toHaveBeenCalledWith('gpt-success', {
      requestId: 'req-1',
      state,
      signal,
      attempt: 2,
    });
  });

  it('records failure against the breaker with the resolved model and a 1-based attempt', () => {
    const breaker = new CircuitBreaker();
    const recordFailure = vi.spyOn(breaker, 'recordFailure');
    const gateway = createBreakerGateway(baseOptions({ breaker, model: 'gpt-failure' }));
    const state = createMiddlewareStateBag();
    const signal = new AbortController().signal;

    gateway.recordFailure(3, signal, state);

    expect(recordFailure).toHaveBeenCalledWith(
      'gpt-failure',
      {
        requestId: 'req-1',
        state,
        signal,
        attempt: 4,
      },
      undefined,
    );
  });

  it('forwards an optional code through to the breaker, when provided', () => {
    const breaker = new CircuitBreaker();
    const recordFailure = vi.spyOn(breaker, 'recordFailure');
    const gateway = createBreakerGateway(baseOptions({ breaker, model: 'gpt-failure' }));
    const state = createMiddlewareStateBag();
    const signal = new AbortController().signal;

    gateway.recordFailure(3, signal, state, 'server_error');

    expect(recordFailure).toHaveBeenCalledWith(
      'gpt-failure',
      { requestId: 'req-1', state, signal, attempt: 4 },
      'server_error',
    );
  });

  it('actually opens the circuit after threshold consecutive failures, same as calling the breaker directly', () => {
    const breaker = new CircuitBreaker({ threshold: 2 });
    const gateway = createBreakerGateway(baseOptions({ breaker }));
    const state = createMiddlewareStateBag();

    gateway.recordFailure(0, undefined, state);
    expect(breaker.getState()).toBe('closed');

    gateway.recordFailure(0, undefined, state);
    expect(breaker.getState()).toBe('open');
  });

  it('resets the breaker on success, same as calling the breaker directly', () => {
    const breaker = new CircuitBreaker({ threshold: 1 });
    const gateway = createBreakerGateway(baseOptions({ breaker }));
    const state = createMiddlewareStateBag();

    gateway.recordFailure(0, undefined, state);
    expect(breaker.getState()).toBe('open');

    // Cooldown hasn't elapsed, so this is a manual reset, not a trial.
    breaker.close();
    gateway.recordSuccess(0, undefined, state);
    expect(breaker.getState()).toBe('closed');
  });
});
