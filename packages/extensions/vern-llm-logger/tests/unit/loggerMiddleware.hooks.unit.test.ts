import {
  createMiddlewareStateBag,
  LLMError,
  type AttemptContext,
  type CallResult,
  type PreDispatchContext,
  type VernLLMEvent,
} from 'vern-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loggerMiddleware, memorySink, type CallLogRecord } from '../../src/index.js';
import { CallRecorder } from '../../src/internal/recorder/callRecorder.js';

// The hooks called directly, the way the core calls them, to pin the guarantees a real
// VernLLM cannot easily break: the exact result and error pass through, and a failure inside the
// logger never reaches the call.

const wrapCtx = (state = createMiddlewareStateBag()) =>
  ({
    requestId: 'req_1',
    stage: 'pre-dispatch',
    context: undefined,
    state,
  }) as unknown as PreDispatchContext;
const attemptCtx = (state: ReturnType<typeof createMiddlewareStateBag>) =>
  ({
    requestId: 'req_1',
    stage: 'attempt',
    requestedProvider: 'primary',
    requestedModel: 'gpt-4o',
    state,
  }) as unknown as AttemptContext;

const request = {} as never;
const result: CallResult = { value: 'answer' };

function build() {
  const sink = memorySink();
  const middleware = loggerMiddleware({ sink, logger: 'silent' });
  return {
    sink,
    wrap: middleware.wrap!,
    dispatch: middleware.dispatch!,
    onEvent: middleware.onEvent!,
    records: () => sink.entries.map(({ entry }) => entry as CallLogRecord),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wrap', () => {
  it('returns the exact result object and writes one record', async () => {
    const { wrap, records } = build();
    const next = vi.fn(async () => result);

    expect(await wrap(request, next, wrapCtx())).toBe(result);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(records()).toHaveLength(1);
  });

  it('rethrows the exact error object and writes one error record', async () => {
    const { wrap, records } = build();
    const boom = new LLMError('provider said no', 'api', { status: 500 });

    await expect(
      wrap(
        request,
        async () => {
          throw boom;
        },
        wrapCtx(),
      ),
    ).rejects.toBe(boom);

    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ outcome: 'error', error: { type: 'api', status: 500 } });
  });

  it('rethrows a value that is not an Error exactly as thrown', async () => {
    const { wrap } = build();

    await expect(
      wrap(
        request,
        async () => {
          throw 'plain string';
        },
        wrapCtx(),
      ),
    ).rejects.toBe('plain string');
  });

  it('calls next untouched, and writes nothing, when the recorder cannot start', async () => {
    vi.spyOn(CallRecorder, 'start').mockImplementation(() => {
      throw new Error('start failed');
    });
    const { wrap, records } = build();
    const next = vi.fn(async () => result);

    expect(await wrap(request, next, wrapCtx())).toBe(result);
    expect(next).toHaveBeenCalledTimes(1);
    expect(records()).toHaveLength(0);
  });

  it('calls next untouched when the recorder cannot be stored in the call state', async () => {
    const { wrap, records } = build();
    const state = {
      get: () => undefined,
      set: () => {
        throw new Error('frozen');
      },
    };
    const next = vi.fn(async () => result);

    expect(await wrap(request, next, wrapCtx(state as never))).toBe(result);
    expect(next).toHaveBeenCalledTimes(1);
    expect(records()).toHaveLength(0);
  });

  it('returns the result even when the sink throws', async () => {
    const middleware = loggerMiddleware({
      sink: {
        write: () => {
          throw new Error('disk full');
        },
      },
      logger: 'silent',
    });

    expect(await middleware.wrap!(request, async () => result, wrapCtx())).toBe(result);
  });

  it('rethrows the original error even when the sink throws', async () => {
    const middleware = loggerMiddleware({
      sink: {
        write: () => {
          throw new Error('disk full');
        },
      },
      logger: 'silent',
    });
    const boom = new Error('call failed');

    await expect(
      middleware.wrap!(
        request,
        async () => {
          throw boom;
        },
        wrapCtx(),
      ),
    ).rejects.toBe(boom);
  });

  it('never narrows or reorders targets', async () => {
    const { wrap } = build();
    const next = vi.fn(async (_options?: { targets?: readonly string[] }) => result);

    await wrap(request, next, wrapCtx());

    expect(next.mock.calls[0]).toEqual([]);
  });
});

describe('dispatch', () => {
  it('passes straight through when the call has no recorder', async () => {
    const { dispatch } = build();
    const next = vi.fn(async () => {});

    await dispatch(request, next, attemptCtx(createMiddlewareStateBag()));

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rethrows the exact error the adapter threw, and calls next once', async () => {
    const { wrap, dispatch, records } = build();
    const state = createMiddlewareStateBag();
    const boom = new LLMError('x', 'api', { status: 500 });
    const next = vi.fn(async () => {
      throw boom;
    });

    await wrap(
      request,
      async () => {
        await expect(dispatch(request, next, attemptCtx(state))).rejects.toBe(boom);
        return result;
      },
      wrapCtx(state),
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(records()[0]).toMatchObject({ attempts: 1, path: [{ attempts: 1 }] });
  });

  it('records an attempt that completes', async () => {
    const { wrap, dispatch, records } = build();
    const state = createMiddlewareStateBag();

    await wrap(
      request,
      async () => {
        await dispatch(request, async () => {}, attemptCtx(state));
        return result;
      },
      wrapCtx(state),
    );

    expect(records()[0]).toMatchObject({
      attempts: 1,
      path: [{ provider: 'primary', outcome: 'ok' }],
    });
  });
});

describe('onEvent', () => {
  const retry = (): VernLLMEvent => ({
    kind: 'retry',
    requestId: 'req_1',
    provider: 'primary',
    model: 'gpt-4o',
    attempt: 1,
    maxRetries: 2,
    delayMs: 10,
    retryAfterHonored: false,
    error: new LLMError('x', 'api'),
  });

  it('applies an event to the call it belongs to', async () => {
    const { wrap, onEvent, records } = build();
    const state = createMiddlewareStateBag();

    await wrap(
      request,
      async () => {
        onEvent(retry(), wrapCtx(state));
        return result;
      },
      wrapCtx(state),
    );

    expect(records()[0]).toMatchObject({ retries: 1, retryDelayMs: 10 });
  });

  it('ignores an event with no call to attach it to', () => {
    const { onEvent, records } = build();

    expect(() => {
      onEvent(retry(), undefined as never);
      onEvent(retry(), wrapCtx());
    }).not.toThrow();
    expect(records()).toHaveLength(0);
  });

  it('keeps first party custom events by default and drops others', async () => {
    const { wrap, onEvent, records } = build();
    const state = createMiddlewareStateBag();
    const custom = (name: string): VernLLMEvent => ({
      kind: 'custom',
      requestId: 'req_1',
      name,
      source: 's',
      data: { a: 1 },
    });

    await wrap(
      request,
      async () => {
        onEvent(custom('router.decision'), wrapCtx(state));
        onEvent(custom('myapp.thing'), wrapCtx(state));
        return result;
      },
      wrapCtx(state),
    );

    expect(records()[0]!.custom).toEqual({ 'router.decision': [{ a: 1 }] });
  });
});
