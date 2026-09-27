import { describe, expect, it, vi } from 'vitest';

import {
  LLMError,
  VernLLM,
  type AttemptContext,
  type PreDispatchContext,
  type RateLimiterAdapter,
  type VernLLMEvent,
  type VernLLMMiddleware,
  type WireCallRequest,
} from '../../../src/index.js';
import {
  FakeApiError,
  createMockClient,
  createMockStreamingClient,
  drain,
  textResponse,
} from '../../helpers.js';

function recordingLimiter(order: string[]): RateLimiterAdapter {
  return {
    estimate: () => 1,
    acquire: vi.fn(async () => {
      order.push('acquire');
      return { release: () => order.push('release'), waitedMs: 0 };
    }),
    signalRateLimit: () => {},
    reactToRateLimitHint: () => {},
  };
}

describe('middleware dispatch', () => {
  it('runs after the limiter and every transform, and sees the request exactly as sent', async () => {
    const order: string[] = [];
    const { client, calls } = createMockClient([
      () => {
        order.push('provider');
        return textResponse('hi');
      },
    ]);
    let seen: Readonly<WireCallRequest> | undefined;

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      rateLimit: recordingLimiter(order),
      middleware: [
        {
          name: 'observer',
          dispatch: async (request, next) => {
            order.push('dispatch:before');
            seen = request;
            await next();
            order.push('dispatch:after');
          },
        },
        {
          name: 'late-transform',
          priority: 10,
          transform: () => {
            order.push('transform');
            return { max_tokens: 42 };
          },
        },
      ],
    });

    await expect(llm.call({ userContent: 'hello', jsonMode: false })).resolves.toBe('hi');

    expect(order).toEqual([
      'transform',
      'acquire',
      'dispatch:before',
      'provider',
      'dispatch:after',
      'release',
    ]);
    expect(seen).toEqual(calls[0]);
    expect(seen?.max_tokens).toBe(42);
  });

  it('runs once per attempt, and next() rejects with the attempt error as an LLMError', async () => {
    const { client } = createMockClient([new FakeApiError('busy', 503), textResponse('ok')]);
    const attempts: number[] = [];
    const outcomes: unknown[] = [];

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      maxRetries: 1,
      logger: 'silent',
      baseDelayMs: 0,
      middleware: [
        {
          dispatch: async (_request, next, ctx) => {
            attempts.push(ctx.attempt);
            try {
              await next();
              outcomes.push('ok');
            } catch (error) {
              outcomes.push(error);
              throw error;
            }
          },
        },
      ],
    });

    await expect(llm.call({ userContent: 'hello', jsonMode: false })).resolves.toBe('ok');

    expect(attempts).toEqual([1, 2]);
    expect(outcomes[0]).toBeInstanceOf(LLMError);
    expect((outcomes[0] as LLMError).status).toBe(503);
    expect(outcomes[1]).toBe('ok');
  });

  it('keeps honoring Retry-After with a hook in place', async () => {
    const { client } = createMockClient([
      new FakeApiError('slow down', 429, { 'retry-after-ms': '5' }),
      textResponse('ok'),
    ]);
    const events: VernLLMEvent[] = [];

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      maxRetries: 1,
      logger: 'silent',
      onEvent: (event) => events.push(event),
      middleware: [{ dispatch: (_request, next) => next() }],
    });

    await llm.call({ userContent: 'hello', jsonMode: false });

    const retry = events.find((event) => event.kind === 'retry');
    expect(retry).toMatchObject({ retryAfterHonored: true, delayMs: 5 });
  });

  it('fails the call without a request when the hook never calls next()', async () => {
    const { client, create } = createMockClient([textResponse('never')]);

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [{ name: 'skipper', dispatch: async () => {} }],
    });

    const error = await llm.call({ userContent: 'hello', jsonMode: false }).catch((e) => e);

    expect(create).not.toHaveBeenCalled();
    expect(error).toMatchObject({ type: 'invalid_params', code: 'middleware_threw' });
  });

  it('skips a disabled entry', async () => {
    const { client } = createMockClient([textResponse('hi')]);
    const dispatch = vi.fn(async (_request: unknown, next: () => Promise<void>) => next());

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [{ enabled: () => false, dispatch }],
    });

    await llm.call({ userContent: 'hello', jsonMode: false });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('nests in wrap order, so position: outermost wraps every other hook', async () => {
    const { client } = createMockClient([textResponse('hi')]);
    const order: string[] = [];
    const around =
      (label: string): VernLLMMiddleware['dispatch'] =>
      async (_request, next) => {
        order.push(`${label}:before`);
        await next();
        order.push(`${label}:after`);
      };

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [
        { name: 'first', dispatch: around('first') },
        { name: 'pinned', position: 'outermost', priority: 100, dispatch: around('pinned') },
      ],
    });

    await llm.call({ userContent: 'hello', jsonMode: false });

    expect(order).toEqual(['pinned:before', 'first:before', 'first:after', 'pinned:after']);
  });

  it('resolves next() once a stream opens, before the caller reads it', async () => {
    const { client } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'a' },
        { type: 'text-delta', delta: 'b' },
      ],
    ]);
    const order: string[] = [];

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      middleware: [
        {
          dispatch: async (_request, next) => {
            await next();
            order.push('opened');
          },
        },
      ],
    });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hello',
      stream: true,
      jsonMode: false,
    });
    order.push('returned');
    await drain(chunks);

    await expect(finalResult).resolves.toBe('ab');
    expect(order).toEqual(['opened', 'returned']);
  });
});

describe('middleware context, adapter and transform names', () => {
  it('reports each target adapter and the entries with a transform', async () => {
    const { client: primaryClient } = createMockClient([new FakeApiError('down', 500)]);
    const { client: fallbackClient } = createMockClient([textResponse('from fallback')]);
    primaryClient.adapter = { name: 'openai-compatible', provider: 'openai' };
    const seen: AttemptContext[] = [];
    let wrapCtx: PreDispatchContext | undefined;

    const llm = new VernLLM({
      client: primaryClient,
      model: 'gpt-4o',
      maxRetries: 0,
      logger: 'silent',
      fallback: { client: fallbackClient, model: 'other' },
      middleware: [
        { name: 'shaper', transform: () => ({}) },
        {
          name: 'observer',
          wrap: async (_request, next, ctx) => {
            wrapCtx = ctx;
            return next();
          },
          dispatch: async (_request, next, ctx) => {
            seen.push(ctx);
            await next();
          },
        },
      ],
    });

    await llm.call({ userContent: 'hello', jsonMode: false });

    expect(wrapCtx?.primaryAdapter).toEqual({ name: 'openai-compatible', provider: 'openai' });
    expect(seen.map((ctx) => ctx.adapter)).toEqual([
      { name: 'openai-compatible', provider: 'openai' },
      { name: 'custom' },
    ]);
    expect(seen[0]!.transformMiddlewareNames).toEqual(['shaper']);
    expect(seen[0]!.registeredMiddlewareNames).toEqual(['shaper', 'observer']);
    expect(Object.isFrozen(seen[0]!.adapter)).toBe(true);
  });

  it('reports the adapter on a circuit transition with no call behind it', async () => {
    const { client } = createMockClient([textResponse('hi')]);
    client.adapter = { name: 'anthropic', provider: 'anthropic' };
    const contexts: AttemptContext[] = [];

    const llm = new VernLLM({
      client,
      model: 'claude',
      circuitBreaker: true,
      middleware: [
        {
          onEvent: (event, ctx) => {
            if (event.kind === 'circuit_state' && ctx.stage === 'attempt') contexts.push(ctx);
          },
        },
      ],
    });

    llm.openCircuit();

    expect(contexts[0]?.adapter).toEqual({ name: 'anthropic', provider: 'anthropic' });
    expect(contexts[0]?.transformMiddlewareNames).toEqual([]);
  });
});
