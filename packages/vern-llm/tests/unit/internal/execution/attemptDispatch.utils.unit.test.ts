import { describe, expect, it, vi } from 'vitest';

import { createBreakerGateway } from '../../../../src/internal/execution/circuitBreakerContext.js';
import { prepareAttempt } from '../../../../src/internal/execution/utils/attemptDispatch.utils.js';
import { createMiddlewareStateBag } from '../../../../src/types/middleware.js';

import type { RequestBuilder } from '../../../../src/internal/execution/requestBuilder.js';
import type { RateLimiter } from '../../../../src/rateLimit.js';
import type {
  CallParams,
  VernLLMMiddleware,
  WireCallRequest,
} from '../../../../src/types/index.js';

/** Matches the local `noopLogger` helper other execution tests use (see `retry.utils.unit.test.ts`). */
function noopLogger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const wireRequest: WireCallRequest = {
  model: 'test-model',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hello' }],
};

/** A `RequestBuilder`-shaped fake, so `prepareAttempt` is tested without exercising the real request-shaping logic (already covered by `requestBuilder.unit.test.ts`). */
function fakeRequestBuilder(overrides: Partial<{ useJson: boolean; model: string }> = {}) {
  return {
    build: vi.fn(() => ({
      useJson: overrides.useJson ?? false,
      model: overrides.model ?? wireRequest.model,
      request: wireRequest,
    })),
  } as unknown as RequestBuilder;
}

function fakeLimiter(acquireResult: {
  release: (actualTokens?: number) => void;
  waitedMs: number;
  reason?: 'concurrency' | 'rpm' | 'tpm';
}): RateLimiter {
  return {
    estimate: vi.fn(() => 42),
    acquire: vi.fn(async () => acquireResult),
  } as unknown as RateLimiter;
}

function baseParams<T>(
  overrides: Partial<{
    params: CallParams<T>;
    onRequest: () => void;
    gateway: ReturnType<typeof createBreakerGateway>;
    requestBuilder: RequestBuilder;
    limiter: RateLimiter | undefined;
    middleware: VernLLMMiddleware[];
  }> = {},
) {
  const gateway =
    overrides.gateway ??
    createBreakerGateway({
      breaker: undefined,
      requestId: 'req-1',
      model: 'test-model',
      providerName: 'openai',
      isFallback: false,
      supportsJsonObjectMode: true,
    });

  return {
    params: (overrides.params ?? {}) as CallParams<T>,
    requestId: 'req-1',
    attempt: 0,
    onRequest: overrides.onRequest,
    middlewareState: undefined,
    gateway,
    requestBuilder: overrides.requestBuilder ?? fakeRequestBuilder(),
    providerName: 'openai',
    limiter: overrides.limiter,
    middleware: overrides.middleware ?? [],
    middlewareTimeoutMs: 5000,
    logger: noopLogger(),
    reportEvent: vi.fn(),
  };
}

describe('prepareAttempt', () => {
  it('builds the request via requestBuilder and returns useJson/model/request through', async () => {
    const requestBuilder = fakeRequestBuilder({ useJson: true, model: 'gpt-x' });

    const result = await prepareAttempt(baseParams({ requestBuilder }));

    expect(requestBuilder.build).toHaveBeenCalledOnce();
    expect(result.useJson).toBe(true);
    expect(result.model).toBe('gpt-x');
    expect(result.request).toEqual(wireRequest);
  });

  it('creates a fresh middleware state bag when none is passed', async () => {
    const result = await prepareAttempt(baseParams());

    expect(result.state.get).toBeTypeOf('function');
  });

  it('reuses the passed-in middleware state bag instead of creating a new one', async () => {
    const state = createMiddlewareStateBag();
    const params = baseParams();

    const result = await prepareAttempt({ ...params, middlewareState: state });

    expect(result.state).toBe(state);
  });

  it('calls onRequest with a snapshot of the outgoing request', async () => {
    const onRequest = vi.fn();

    await prepareAttempt(baseParams({ onRequest }));

    expect(onRequest).toHaveBeenCalledOnce();
    expect(onRequest).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openai', model: 'test-model', body: wireRequest }),
    );
  });

  it('is a no-op on rate limiting when no limiter is configured', async () => {
    const result = await prepareAttempt(baseParams({ limiter: undefined }));

    expect(result.release).toBeUndefined();
  });

  it('wires the release from an acquired limiter through unchanged', async () => {
    const release = vi.fn();
    const limiter = fakeLimiter({ release, waitedMs: 0 });

    const result = await prepareAttempt(baseParams({ limiter }));

    expect(result.release).toBe(release);
  });

  it("estimates capacity from the fully built (post-transform) request, not the caller's params", async () => {
    const limiter = fakeLimiter({ release: vi.fn(), waitedMs: 0 });

    await prepareAttempt(baseParams({ limiter }));

    expect(limiter.estimate).toHaveBeenCalledWith(wireRequest);
    expect(limiter.acquire).toHaveBeenCalledWith(42, undefined);
  });
});

describe('prepareAttempt, rate_limited event', () => {
  it('does not report rate_limited when the acquire did not have to wait', async () => {
    const limiter = fakeLimiter({ release: vi.fn(), waitedMs: 0 });
    const reportEvent = vi.fn();

    await prepareAttempt({ ...baseParams({ limiter }), reportEvent });

    expect(reportEvent).not.toHaveBeenCalled();
  });

  it('reports rate_limited with the waited time and reason when the acquire had to wait', async () => {
    const limiter = fakeLimiter({ release: vi.fn(), waitedMs: 250, reason: 'tpm' });
    const reportEvent = vi.fn();

    await prepareAttempt({ ...baseParams({ limiter }), reportEvent });

    expect(reportEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: 'rate_limited',
        requestId: 'req-1',
        provider: 'openai',
        model: 'test-model',
        waitedMs: 250,
        reason: 'tpm',
      }),
    );
  });
});
