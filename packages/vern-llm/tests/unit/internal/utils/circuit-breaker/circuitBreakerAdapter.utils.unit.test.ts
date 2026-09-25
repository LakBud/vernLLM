import { describe, expect, it, vi } from 'vitest';

import { CircuitBreaker, type CircuitBreakerAdapter } from '../../../../../src/circuitBreaker.js';
import { buildCircuitBreaker } from '../../../../../src/internal/utils/circuit-breaker/circuitBreakerAdapter.utils.js';
import { LLMError } from '../../../../../src/types/errors.js';

import type { Logger } from '../../../../../src/logger.js';

function fakeLogger(): Logger {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('buildCircuitBreaker', () => {
  it('returns undefined when circuitBreakerOption is falsy', () => {
    const logger = fakeLogger();

    expect(
      buildCircuitBreaker(undefined, 'openai', 'gpt-4o', undefined, logger, [], 5000, false, true),
    ).toBeUndefined();
    expect(
      buildCircuitBreaker(false, 'openai', 'gpt-4o', undefined, logger, [], 5000, false, true),
    ).toBeUndefined();
  });

  it('fans a transition with no call context out to middleware onEvent too, with a fresh identity', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn();
    const middlewareOnEvent = vi.fn();

    const breaker = buildCircuitBreaker(
      true,
      'openai',
      'gpt-4o',
      onEvent,
      logger,
      [{ name: 'observer', onEvent: middlewareOnEvent }],
      5000,
      false,
      true,
    ) as CircuitBreaker;

    breaker.open();
    breaker.close();

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(middlewareOnEvent).toHaveBeenCalledTimes(2);

    const [event, ctx] = middlewareOnEvent.mock.calls[0]!;
    expect(event).toMatchObject({ kind: 'circuit_state', provider: 'openai', to: 'open' });
    expect(ctx).toMatchObject({
      stage: 'attempt',
      requestedProvider: 'openai',
      requestedModel: 'gpt-4o',
      attempt: 1,
      registeredMiddlewareNames: ['observer'],
    });
    expect(typeof ctx.requestId).toBe('string');
    // Two unrelated transitions never share an identity or state.
    const secondCtx = middlewareOnEvent.mock.calls[1]![1];
    expect(secondCtx.requestId).not.toBe(ctx.requestId);
    expect(secondCtx.state).not.toBe(ctx.state);
  });

  it('reports the state-change event directly (no middleware context) when the breaker is driven without a call context, e.g. manual open()', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn();

    const breaker = buildCircuitBreaker(
      true,
      'openai',
      'gpt-4o',
      onEvent,
      logger,
      [],
      5000,
      false,
      true,
    ) as CircuitBreaker;

    // No context passed, so a fresh identity stands in for the call.
    breaker.open();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'circuit_state', provider: 'openai', to: 'open' }),
    );
  });

  it('builds an AttemptContext and routes through emitEvent when the breaker is driven with a call context, e.g. assertClosed()', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn();

    const breaker = buildCircuitBreaker(
      true,
      'openai',
      'gpt-4o',
      onEvent,
      logger,
      [],
      5000,
      false,
      true,
    ) as CircuitBreaker;

    breaker.open(); // circuit is now open

    // Elapsed cooldown lets assertClosed transition open -> half-open,
    // this time WITH a context, exercising the AttemptContext-building
    // branch instead of the plain reportEvent() one.
    vi.useFakeTimers();
    vi.advanceTimersByTime(31_000);

    breaker.assertClosed('gpt-4o', { requestId: 'req-1', state: new Map(), attempt: 2 });

    vi.useRealTimers();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'circuit_state', provider: 'openai', to: 'half-open' }),
    );
  });

  it('falls back to defaultModel in requestedModel when the call context omits a model', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn();

    const breaker = buildCircuitBreaker(
      true,
      'openai',
      'gpt-4o-default',
      onEvent,
      logger,
      [],
      5000,
      false,
      true,
    ) as CircuitBreaker;

    breaker.open();

    vi.useFakeTimers();
    vi.advanceTimersByTime(31_000);

    // No model passed here, so `model ?? defaultModel` should resolve to
    // the constructor's defaultModel.
    breaker.assertClosed(undefined, { requestId: 'req-1', state: new Map(), attempt: 1 });

    vi.useRealTimers();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o-default', to: 'half-open' }),
    );
  });

  it('swallows and logs an error thrown by onEvent, instead of propagating it', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn(() => {
      throw new Error('onEvent boom');
    });

    const breaker = buildCircuitBreaker(
      true,
      'openai',
      'gpt-4o',
      onEvent,
      logger,
      [],
      5000,
      false,
      true,
    ) as CircuitBreaker;

    expect(() => breaker.open()).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] onEvent failed', {
      message: 'onEvent boom',
      stack: expect.any(String),
    });
  });

  it('logs "unknown" when onEvent throws a non-Error value', () => {
    const logger = fakeLogger();
    const onEvent = vi.fn(() => {
      throw 'not an Error instance';
    });

    const breaker = buildCircuitBreaker(
      true,
      'openai',
      'gpt-4o',
      onEvent,
      logger,
      [],
      5000,
      false,
      true,
    ) as CircuitBreaker;

    expect(() => breaker.open()).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] onEvent failed', {
      message: 'unknown',
    });
  });

  it('swallows and logs an error thrown by a caller-supplied onStateChange, instead of propagating it', () => {
    const logger = fakeLogger();
    const userOnStateChange = vi.fn(() => {
      throw new Error('onStateChange boom');
    });

    const breaker = buildCircuitBreaker(
      { onStateChange: userOnStateChange },
      'openai',
      'gpt-4o',
      undefined,
      logger,
      [],
      5000,
      false,
      true,
    ) as CircuitBreaker;

    expect(() => breaker.open()).not.toThrow();
    expect(userOnStateChange).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] circuitBreaker.onStateChange failed', {
      message: 'onStateChange boom',
      stack: expect.any(String),
    });
  });

  it('logs "unknown" when the caller-supplied onStateChange throws a non-Error value', () => {
    const logger = fakeLogger();
    const userOnStateChange = vi.fn(() => {
      throw 'not an Error instance';
    });

    const breaker = buildCircuitBreaker(
      { onStateChange: userOnStateChange },
      'openai',
      'gpt-4o',
      undefined,
      logger,
      [],
      5000,
      false,
      true,
    ) as CircuitBreaker;

    expect(() => breaker.open()).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] circuitBreaker.onStateChange failed', {
      message: 'unknown',
    });
  });

  describe('a full CircuitBreakerAdapter passed instead of CircuitBreakerOptions', () => {
    function fakeAdapter(overrides: Record<string, unknown> = {}) {
      return {
        assertClosed: vi.fn(),
        recordSuccess: vi.fn(),
        recordFailure: vi.fn(),
        onStateChange: vi.fn(),
        ...overrides,
      };
    }

    it('returns the same instance passed in, not a new CircuitBreaker', () => {
      const logger = fakeLogger();
      const adapter = fakeAdapter();

      const built = buildCircuitBreaker(
        adapter as never,
        'openai',
        'gpt-4o',
        undefined,
        logger,
        [],
        5000,
        false,
        true,
      );

      expect(built).toBe(adapter);
    });

    it('wires onStateChange onto the adapter so state changes still report a circuit_state event', () => {
      const logger = fakeLogger();
      const onEvent = vi.fn();
      const adapter = fakeAdapter();

      const built = buildCircuitBreaker(
        adapter as never,
        'openai',
        'gpt-4o',
        onEvent,
        logger,
        [],
        5000,
        false,
        true,
      ) as unknown as { onStateChange: (...args: unknown[]) => void };

      expect(typeof built.onStateChange).toBe('function');
      built.onStateChange('closed', 'open', 3, 'gpt-4o');

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'circuit_state', provider: 'openai', to: 'open' }),
      );
    });

    it("chains the adapter's own onStateChange after reporting the event, rather than discarding it", () => {
      const logger = fakeLogger();
      const userOnStateChange = vi.fn();
      const adapter = fakeAdapter({ onStateChange: userOnStateChange });

      const built = buildCircuitBreaker(
        adapter as never,
        'openai',
        'gpt-4o',
        undefined,
        logger,
        [],
        5000,
        false,
        true,
      ) as unknown as { onStateChange: (...args: unknown[]) => void };

      built.onStateChange('closed', 'open', 1, 'gpt-4o');

      expect(userOnStateChange).toHaveBeenCalledWith('closed', 'open', 1, 'gpt-4o', undefined);
    });

    it('still chains through even a no-op onStateChange, since it is a valid, explicit "I do not care" implementation', () => {
      const logger = fakeLogger();
      const noop = vi.fn(() => {});
      const adapter = fakeAdapter({ onStateChange: noop });
      const onEvent = vi.fn();

      const built = buildCircuitBreaker(
        adapter as never,
        'openai',
        'gpt-4o',
        onEvent,
        logger,
        [],
        5000,
        false,
        true,
      ) as unknown as { onStateChange: (...args: unknown[]) => void };

      built.onStateChange('closed', 'open', 1, 'gpt-4o');

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'circuit_state', to: 'open' }),
      );
      expect(noop).toHaveBeenCalledOnce();
    });

    it('treats an object with some but not all required members as an incomplete adapter, not plain options', () => {
      const logger = fakeLogger();
      const partial = { assertClosed: vi.fn(), recordSuccess: vi.fn(), recordFailure: vi.fn() };

      expect(() =>
        buildCircuitBreaker(
          partial as never,
          'openai',
          'gpt-4o',
          undefined,
          logger,
          [],
          5000,
          false,
          true,
        ),
      ).toThrow(/missing: onStateChange\b/);
    });

    it('lists every missing member when more than one is absent', () => {
      const logger = fakeLogger();
      const partial = { assertClosed: vi.fn() };

      expect(() =>
        buildCircuitBreaker(
          partial as never,
          'openai',
          'gpt-4o',
          undefined,
          logger,
          [],
          5000,
          false,
          true,
        ),
      ).toThrow(/missing: recordSuccess, recordFailure, onStateChange/);
    });

    it('throws LLMError, not a plain error, for an incomplete adapter', () => {
      const logger = fakeLogger();
      const partial = { assertClosed: vi.fn() };

      expect(() =>
        buildCircuitBreaker(
          partial as never,
          'openai',
          'gpt-4o',
          undefined,
          logger,
          [],
          5000,
          false,
          true,
        ),
      ).toThrow(LLMError);
    });

    it('throws when getState is present but not a function', () => {
      const logger = fakeLogger();
      const adapter = fakeAdapter({ getState: {} });

      expect(() =>
        buildCircuitBreaker(
          adapter as never,
          'openai',
          'gpt-4o',
          undefined,
          logger,
          [],
          5000,
          false,
          true,
        ),
      ).toThrow(/getState.*must be a function/);
    });

    it('throws when open, close, or getFailureBreakdown are present but not functions, same as getState', () => {
      const logger = fakeLogger();

      for (const name of ['open', 'close', 'getFailureBreakdown'] as const) {
        const adapter = fakeAdapter({ [name]: 'not a function' });

        expect(() =>
          buildCircuitBreaker(
            adapter as never,
            'openai',
            'gpt-4o',
            undefined,
            logger,
            [],
            5000,
            false,
            true,
          ),
        ).toThrow(new RegExp(`${name}.*must be a function`));
      }
    });

    it('describes every invalid optional member at once, pluralizing the message when more than one is wrong', () => {
      const logger = fakeLogger();
      const adapter = fakeAdapter({ getState: {}, open: 'nope' });

      expect(() =>
        buildCircuitBreaker(
          adapter as never,
          'openai',
          'gpt-4o',
          undefined,
          logger,
          [],
          5000,
          false,
          true,
        ),
      ).toThrow(/getState \(object\), open \(string\).*They are optional/);
    });

    it('accepts a real adapter when open, close, and getFailureBreakdown are all genuine functions', () => {
      const logger = fakeLogger();
      const adapter = fakeAdapter({
        open: vi.fn(),
        close: vi.fn(),
        getFailureBreakdown: vi.fn(() => ({})),
        isolateByModel: true,
      });

      const built = buildCircuitBreaker(
        adapter as never,
        'openai',
        'gpt-4o',
        undefined,
        logger,
        [],
        5000,
        false,
        true,
      );

      expect(built).toBe(adapter);
    });

    it('accepts a real adapter when getState is a genuine function', () => {
      const logger = fakeLogger();
      const adapter = fakeAdapter({ getState: () => 'closed' });

      const built = buildCircuitBreaker(
        adapter as never,
        'openai',
        'gpt-4o',
        undefined,
        logger,
        [],
        5000,
        false,
        true,
      );

      expect(built).toBe(adapter);
    });

    it('still treats an object with none of the three adapter-only members as plain options, building a real CircuitBreaker', () => {
      const logger = fakeLogger();

      const built = buildCircuitBreaker(
        { threshold: 2 },
        'openai',
        'gpt-4o',
        undefined,
        logger,
        [],
        5000,
        false,
        true,
      );

      expect(built).not.toBeUndefined();
      expect(typeof built!.assertClosed).toBe('function');
    });

    // Regression test: onStateChange is a legitimate CircuitBreakerOptions
    // field too. Its presence alone, with none of assertClosed/
    // recordSuccess/recordFailure, must never be read as "this is an
    // incomplete adapter", or the everyday `circuitBreaker: { threshold,
    // onStateChange }` pattern from Core's docs would start throwing.
    it('does not mistake plain CircuitBreakerOptions.onStateChange for an attempted adapter, and builds a real CircuitBreaker', () => {
      const logger = fakeLogger();
      const userOnStateChange = vi.fn();

      const built = buildCircuitBreaker(
        { threshold: 5, cooldownMs: 30_000, onStateChange: userOnStateChange },
        'openai',
        'gpt-4o',
        undefined,
        logger,
        [],
        5000,
        false,
        true,
      );

      expect(built).toBeInstanceOf(CircuitBreaker);
      (built as CircuitBreaker).open();
      expect(userOnStateChange).toHaveBeenCalledWith('closed', 'open', 0, undefined, undefined);
    });

    // Regression test for the sharing bug found in review: naively
    // reassigning `adapter.onStateChange = wrap(adapter.onStateChange)`
    // on every build looked like it "replaced" the previous wiring but
    // actually chained onto it, so both targets fired on every real
    // transition, growing one call deeper each time the same adapter
    // instance was built against again. `wireAdapterOnStateChange`'s
    // dispatcher fixes this: every subscribing target still gets its own
    // tagged event, but the adapter's own original `onStateChange` fires
    // exactly once per transition, not once per target.
    describe('sharing one adapter instance across two targets', () => {
      function sharedAdapter(userOnStateChange: CircuitBreakerAdapter['onStateChange']) {
        return {
          assertClosed: vi.fn(),
          recordSuccess: vi.fn(),
          recordFailure: vi.fn(),
          onStateChange: userOnStateChange,
        };
      }

      it('reports a correctly tagged circuit_state event to both targets', () => {
        const logger = fakeLogger();
        const onEventA = vi.fn();
        const onEventB = vi.fn();
        const adapter = sharedAdapter(vi.fn());

        buildCircuitBreaker(
          adapter as never,
          'providerA',
          'modelA',
          onEventA,
          logger,
          [],
          5000,
          false,
          true,
        );
        buildCircuitBreaker(
          adapter as never,
          'providerB',
          'modelB',
          onEventB,
          logger,
          [],
          5000,
          false,
          true,
        );

        adapter.onStateChange('closed', 'open', 1, 'm');

        expect(onEventA).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ kind: 'circuit_state', provider: 'providerA' }),
        );
        expect(onEventB).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ kind: 'circuit_state', provider: 'providerB' }),
        );
      });

      it("calls the adapter's own original onStateChange exactly once per transition, not once per sharing target", () => {
        const logger = fakeLogger();
        const userOnStateChange = vi.fn();
        const adapter = sharedAdapter(userOnStateChange);

        buildCircuitBreaker(
          adapter as never,
          'providerA',
          'modelA',
          undefined,
          logger,
          [],
          5000,
          false,
          true,
        );
        buildCircuitBreaker(
          adapter as never,
          'providerB',
          'modelB',
          undefined,
          logger,
          [],
          5000,
          false,
          true,
        );

        adapter.onStateChange('closed', 'open', 1, 'm');

        expect(userOnStateChange).toHaveBeenCalledExactlyOnceWith(
          'closed',
          'open',
          1,
          'm',
          undefined,
        );
      });

      it('warns on the second build against the same adapter instance, not the first', () => {
        const loggerA = fakeLogger();
        const loggerB = fakeLogger();
        const adapter = sharedAdapter(vi.fn());

        buildCircuitBreaker(
          adapter as never,
          'providerA',
          'modelA',
          undefined,
          loggerA,
          [],
          5000,
          false,
          true,
        );

        expect(loggerA.warn).not.toHaveBeenCalled();

        buildCircuitBreaker(
          adapter as never,
          'providerB',
          'modelB',
          undefined,
          loggerB,
          [],
          5000,
          false,
          true,
        );

        expect(loggerB.warn).toHaveBeenCalledExactlyOnceWith(
          expect.stringMatching(/already wired to another target/),
        );
      });

      it('warns only once ever per adapter, not once per additional build against it, so a hot loop reusing one adapter does not spam the log', () => {
        const logger = fakeLogger();
        const adapter = sharedAdapter(vi.fn());

        for (let i = 0; i < 5; i++) {
          buildCircuitBreaker(
            adapter as never,
            `provider${i}`,
            `model${i}`,
            undefined,
            logger,
            [],
            5000,
            false,
            true,
          );
        }

        expect(logger.warn).toHaveBeenCalledTimes(1);
      });

      it("swallows and logs an error thrown by the adapter's own original onStateChange, without stopping a sharing target's own subscriber from running", () => {
        const logger = fakeLogger();
        const onEventA = vi.fn();
        const throwingOriginal = vi.fn(() => {
          throw new Error('original onStateChange boom');
        });
        const adapter = sharedAdapter(throwingOriginal);

        buildCircuitBreaker(
          adapter as never,
          'providerA',
          'modelA',
          onEventA,
          logger,
          [],
          5000,
          false,
          true,
        );

        expect(() => adapter.onStateChange('closed', 'open', 1, 'm')).not.toThrow();
        expect(onEventA).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ kind: 'circuit_state', to: 'open' }),
        );
        expect(logger.error).toHaveBeenCalledWith('[VernLLM] circuitBreaker.onStateChange failed', {
          message: 'original onStateChange boom',
          stack: expect.any(String),
        });
      });

      it('a throwing subscriber for one sharing target does not stop another sharing target from being notified', () => {
        const loggerA = fakeLogger();
        const loggerB = fakeLogger();
        const onEventA = vi.fn(() => {
          throw new Error('onEventA boom');
        });
        const onEventB = vi.fn();
        const adapter = sharedAdapter(vi.fn());

        buildCircuitBreaker(
          adapter as never,
          'providerA',
          'modelA',
          onEventA,
          loggerA,
          [],
          5000,
          false,
          true,
        );
        buildCircuitBreaker(
          adapter as never,
          'providerB',
          'modelB',
          onEventB,
          loggerB,
          [],
          5000,
          false,
          true,
        );

        expect(() => adapter.onStateChange('closed', 'open', 1, 'm')).not.toThrow();
        expect(onEventA).toHaveBeenCalledOnce();
        expect(onEventB).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ kind: 'circuit_state', provider: 'providerB' }),
        );
      });

      it('does not warn when two different adapter instances are built, even with identical shapes', () => {
        const logger = fakeLogger();

        buildCircuitBreaker(
          sharedAdapter(vi.fn()) as never,
          'providerA',
          'modelA',
          undefined,
          logger,
          [],
          5000,
          false,
          true,
        );
        buildCircuitBreaker(
          sharedAdapter(vi.fn()) as never,
          'providerB',
          'modelB',
          undefined,
          logger,
          [],
          5000,
          false,
          true,
        );

        expect(logger.warn).not.toHaveBeenCalled();
      });
    });
  });
});
