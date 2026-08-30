import { describe, expect, it, vi } from 'vitest';

import {
  finalizeResponse,
  type FinalizeResponseDeps,
} from '../../../../src/internal/execution/responseFinalizer.js';
import { LLMError } from '../../../../src/types/errors.js';
import { createMiddlewareStateBag } from '../../../../src/types/middleware.js';

import type { BreakerGateway } from '../../../../src/internal/execution/circuitBreakerContext.js';
import type { UsageReporter } from '../../../../src/internal/execution/usageReporter.js';
import type { CallParams, TokenUsage } from '../../../../src/types/index.js';

function fakeGateway(): BreakerGateway {
  return {
    buildAttemptContext: vi.fn(),
    buildCallContext: vi.fn(),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  };
}

function fakeUsageReporter(): UsageReporter {
  return {
    extract: vi.fn(),
    actualTokensFor: vi.fn(),
    reportSuccess: vi.fn(),
    reportFailure: vi.fn(),
  };
}

function baseDeps(overrides: Partial<FinalizeResponseDeps> = {}): FinalizeResponseDeps {
  return {
    gateway: fakeGateway(),
    usageReporter: fakeUsageReporter(),
    logger: { debug: vi.fn(), warn: vi.fn() },
    redactText: (text: string) => text,
    parseJson: (content: string) => JSON.parse(content) as unknown,
    providerName: 'test-provider',
    isFallback: false,
    model: 'gpt-test',
    ...overrides,
  };
}

function baseParams(overrides: Partial<CallParams<unknown>> = {}): CallParams<unknown> {
  return { userContent: 'hi', jsonMode: false, ...overrides };
}

const state = createMiddlewareStateBag();
const usage: TokenUsage = {
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  requestId: 'req-1',
  model: 'gpt-test',
};

describe('finalizeResponse, success path', () => {
  it('records a breaker success and a usage success when shaping succeeds', () => {
    const deps = baseDeps();

    const result = finalizeResponse(
      'hello',
      undefined,
      baseParams(),
      false,
      usage,
      'req-1',
      0,
      state,
      deps,
    );

    expect(result).toBe('hello');
    expect(deps.gateway.recordSuccess).toHaveBeenCalledExactlyOnceWith(0, undefined, state);
    expect(deps.usageReporter.reportSuccess).toHaveBeenCalledExactlyOnceWith(usage);
    expect(deps.usageReporter.reportFailure).not.toHaveBeenCalled();
    expect(deps.gateway.recordFailure).not.toHaveBeenCalled();
  });

  it('does not report a breaker success on a shaping failure', () => {
    const deps = baseDeps();

    expect(() =>
      finalizeResponse(undefined, undefined, baseParams(), false, usage, 'req-1', 0, state, deps),
    ).toThrow();

    expect(deps.gateway.recordSuccess).not.toHaveBeenCalled();
  });

  it('never calls gateway.recordFailure itself, on either success or failure', () => {
    const deps = baseDeps();

    expect(() =>
      finalizeResponse(undefined, undefined, baseParams(), false, usage, 'req-1', 0, state, deps),
    ).toThrow();

    expect(deps.gateway.recordFailure).not.toHaveBeenCalled();
  });
});

describe('finalizeResponse, failure path', () => {
  it('reports a usage failure with the normalized error when shaping throws and usage is present', () => {
    const deps = baseDeps();

    expect(() =>
      finalizeResponse(undefined, undefined, baseParams(), false, usage, 'req-1', 2, state, deps),
    ).toThrow();

    expect(deps.usageReporter.reportFailure).toHaveBeenCalledExactlyOnceWith(
      usage,
      expect.objectContaining({ code: 'empty_response' }),
      2,
    );
  });

  it('does not report a usage failure when usage is undefined', () => {
    const deps = baseDeps();

    expect(() =>
      finalizeResponse(
        undefined,
        undefined,
        baseParams(),
        false,
        undefined,
        'req-1',
        0,
        state,
        deps,
      ),
    ).toThrow();

    expect(deps.usageReporter.reportFailure).not.toHaveBeenCalled();
  });

  it('does not report a usage failure when the error normalizes to aborted', () => {
    const deps = baseDeps();
    const controller = new AbortController();
    controller.abort();

    expect(() =>
      finalizeResponse(
        undefined,
        undefined,
        baseParams({ signal: controller.signal }),
        false,
        usage,
        'req-1',
        0,
        state,
        deps,
      ),
    ).toThrow(expect.objectContaining({ type: 'aborted' }));

    expect(deps.usageReporter.reportFailure).not.toHaveBeenCalled();
  });

  it('rethrows the normalized error, not the raw thrown value', () => {
    const deps = baseDeps({
      parseJson: () => {
        throw new Error('raw json bug');
      },
    });

    let caught: unknown;
    try {
      finalizeResponse('{bad', undefined, baseParams(), true, usage, 'req-1', 0, state, deps);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LLMError);
  });
});

describe('finalizeResponse, detectSoftFailure', () => {
  it('leaves a clean shape as a success when the hook returns undefined', () => {
    const detectSoftFailure = vi.fn(() => undefined);
    const deps = baseDeps({ detectSoftFailure });

    const result = finalizeResponse(
      'hello',
      undefined,
      baseParams(),
      false,
      usage,
      'req-1',
      0,
      state,
      deps,
    );

    expect(result).toBe('hello');
    expect(deps.gateway.recordSuccess).toHaveBeenCalledOnce();
    expect(deps.usageReporter.reportSuccess).toHaveBeenCalledOnce();
  });

  it('turns a clean shape into a failure when the hook returns a code', () => {
    const detectSoftFailure = vi.fn(() => 'empty_response' as const);
    const deps = baseDeps({ detectSoftFailure });

    expect(() =>
      finalizeResponse('hello', undefined, baseParams(), false, usage, 'req-1', 0, state, deps),
    ).toThrow(expect.objectContaining({ type: 'api', code: 'empty_response' }));

    expect(deps.gateway.recordSuccess).not.toHaveBeenCalled();
    expect(deps.usageReporter.reportSuccess).not.toHaveBeenCalled();
    expect(deps.usageReporter.reportFailure).toHaveBeenCalledExactlyOnceWith(
      usage,
      expect.objectContaining({ code: 'empty_response' }),
      0,
    );
  });

  it('reports the failure exactly once, not once inline and again in the catch path', () => {
    const detectSoftFailure = vi.fn(() => 'empty_response' as const);
    const deps = baseDeps({ detectSoftFailure });

    expect(() =>
      finalizeResponse('hello', undefined, baseParams(), false, usage, 'req-1', 0, state, deps),
    ).toThrow();

    expect(deps.usageReporter.reportFailure).toHaveBeenCalledTimes(1);
    expect(deps.gateway.recordFailure).not.toHaveBeenCalled();
  });

  it('passes the shaped result and call metadata to the hook', () => {
    const detectSoftFailure = vi.fn(() => undefined);
    const deps = baseDeps({
      detectSoftFailure,
      providerName: 'anthropic',
      isFallback: true,
      model: 'claude-x',
    });

    finalizeResponse('hello', undefined, baseParams(), false, usage, 'req-9', 2, state, deps);

    expect(detectSoftFailure).toHaveBeenCalledExactlyOnceWith('hello', {
      requestId: 'req-9',
      model: 'claude-x',
      providerName: 'anthropic',
      isFallback: true,
      attempt: 3,
    });
  });

  it('treats a throwing hook as no soft failure, logging instead of failing the call', () => {
    const detectSoftFailure = vi.fn(() => {
      throw new Error('hook bug');
    });
    const deps = baseDeps({ detectSoftFailure });

    const result = finalizeResponse(
      'hello',
      undefined,
      baseParams(),
      false,
      usage,
      'req-1',
      0,
      state,
      deps,
    );

    expect(result).toBe('hello');
    expect(deps.gateway.recordSuccess).toHaveBeenCalledOnce();
    expect(deps.logger.warn).toHaveBeenCalledOnce();
  });

  it('is never consulted when a shaping error already occurred', () => {
    const detectSoftFailure = vi.fn(() => undefined);
    const deps = baseDeps({ detectSoftFailure });

    expect(() =>
      finalizeResponse(undefined, undefined, baseParams(), false, usage, 'req-1', 0, state, deps),
    ).toThrow();

    expect(detectSoftFailure).not.toHaveBeenCalled();
  });

  it('is not consulted at all when no hook is configured', () => {
    const deps = baseDeps();

    const result = finalizeResponse(
      'hello',
      undefined,
      baseParams(),
      false,
      usage,
      'req-1',
      0,
      state,
      deps,
    );

    expect(result).toBe('hello');
    expect(deps.gateway.recordSuccess).toHaveBeenCalledOnce();
  });
});
