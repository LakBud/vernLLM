import { afterEach, describe, expect, it, vi } from 'vitest';

import { CircuitBreaker } from '../../../src/circuitBreaker.js';
import {
  buildExecutors,
  type ExecutorFactoryShared,
} from '../../../src/internal/executorFactory.js';
import { LLMError } from '../../../src/types/errors.js';
import { createMockClient } from '../../helpers.js';

import type { FallbackTarget } from '../../../src/types/index.js';

const rateLimiterCtorSpy = vi.fn();

vi.mock('../../../src/rateLimit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/rateLimit.js')>();

  return {
    ...actual,
    RateLimiter: class extends actual.RateLimiter {
      constructor(...args: ConstructorParameters<typeof actual.RateLimiter>) {
        super(...args);
        rateLimiterCtorSpy(...args);
      }
    },
  };
});

function target(overrides: Partial<FallbackTarget> = {}): FallbackTarget {
  return {
    client: createMockClient([]).client,
    model: 'target-model',
    ...overrides,
  };
}

function shared(overrides: Partial<ExecutorFactoryShared> = {}): ExecutorFactoryShared {
  return {
    providerName: 'primary',
    primaryDefaultTemperature: 0.2,
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    middleware: [],
    middlewareTimeoutMs: 5000,
    ...overrides,
  };
}

afterEach(() => {
  rateLimiterCtorSpy.mockClear();
});

describe('buildExecutors, naming', () => {
  it('names the primary from shared.providerName when the target sets no name', () => {
    const [primary] = buildExecutors(target(), [], shared({ providerName: 'my-provider' }));

    expect(primary!.providerName).toBe('my-provider');
  });

  it('names fallback targets fallback[i], 0-indexed, when they set no name', () => {
    const executors = buildExecutors(target(), [target(), target()], shared());

    expect(executors[1]!.providerName).toBe('fallback[0]');
    expect(executors[2]!.providerName).toBe('fallback[1]');
  });

  it("uses a target's own name when it sets one, for both primary and fallback", () => {
    const executors = buildExecutors(
      target({ name: 'custom-primary' }),
      [target({ name: 'custom-fallback' })],
      shared(),
    );

    expect(executors[0]!.providerName).toBe('custom-primary');
    expect(executors[1]!.providerName).toBe('custom-fallback');
  });

  it('throws when a fallback reuses the primary name', () => {
    expect(() =>
      buildExecutors(target({ name: 'claude' }), [target({ name: 'claude' })], shared()),
    ).toThrow(/target name "claude" is used by more than one target/);
  });

  it('throws when two fallbacks share a name', () => {
    expect(() =>
      buildExecutors(target(), [target({ name: 'x' }), target({ name: 'x' })], shared()),
    ).toThrow(/target name "x"/);
  });

  it("throws when a hand set name matches another target's default", () => {
    // Primary defaults to shared.providerName, so a fallback named after it collides.
    expect(() =>
      buildExecutors(target(), [target({ name: 'primary' })], shared({ providerName: 'primary' })),
    ).toThrow(/target name "primary"/);
    expect(() =>
      buildExecutors(target(), [target(), target({ name: 'fallback[0]' })], shared()),
    ).toThrow(/target name "fallback\[0\]"/);
  });

  it('throws a plain Error, not an LLMError', () => {
    let thrown: unknown;
    try {
      buildExecutors(target({ name: 'a' }), [target({ name: 'a' })], shared());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(LLMError);
  });
});

describe('buildExecutors, per target option inheritance', () => {
  it('builds one executor per target, primary first', () => {
    const executors = buildExecutors(target(), [target(), target()], shared());

    expect(executors).toHaveLength(3);
  });

  it("carries each target's own model through to its executor", () => {
    const executors = buildExecutors(
      target({ model: 'primary-model' }),
      [target({ model: 'fallback-model' })],
      shared(),
    );

    expect(executors[0]!.model).toBe('primary-model');
    expect(executors[1]!.model).toBe('fallback-model');
  });

  it('inherits shared.primaryDefaultTemperature when a target leaves defaultTemperature unset', () => {
    const executors = buildExecutors(
      target(),
      [target()],
      shared({ primaryDefaultTemperature: 0.9 }),
    );

    // No direct getter for the resolved default; previewRequest's built
    // request reflects it, since temperature falls back to the
    // instance default when the call itself doesn't override it.
    expect(executors[1]!.previewRequest({ userContent: 'hi' }).request).toMatchObject({
      temperature: 0.9,
    });
  });

  it("keeps a fallback target's own defaultTemperature instead of inheriting the primary's", () => {
    const executors = buildExecutors(
      target(),
      [target({ defaultTemperature: 0.1 })],
      shared({ primaryDefaultTemperature: 0.9 }),
    );

    expect(executors[1]!.previewRequest({ userContent: 'hi' }).request).toMatchObject({
      temperature: 0.1,
    });
  });

  it('lets an explicit null defaultTemperature win over the primary default (omits temperature entirely)', () => {
    const executors = buildExecutors(
      target(),
      [target({ defaultTemperature: null })],
      shared({ primaryDefaultTemperature: 0.9 }),
    );

    expect(executors[1]!.previewRequest({ userContent: 'hi' }).request).not.toHaveProperty(
      'temperature',
    );
  });
});

describe('buildExecutors, breaker only built when configured', () => {
  it('getCircuitState returns undefined when the target has no circuitBreaker', () => {
    const [executor] = buildExecutors(target(), [], shared());

    expect(executor!.getCircuitState()).toBeUndefined();
  });

  it('getCircuitState returns a real state once the target configures a circuitBreaker', () => {
    const [executor] = buildExecutors(target({ circuitBreaker: true }), [], shared());

    expect(executor!.getCircuitState()).toBeDefined();
  });

  it("each target's circuitBreaker is independent, not inherited from the primary", () => {
    const executors = buildExecutors(target({ circuitBreaker: true }), [target()], shared());

    expect(executors[0]!.getCircuitState()).toBeDefined();
    expect(executors[1]!.getCircuitState()).toBeUndefined();
  });

  it('a fallback target uses a CircuitBreakerAdapter as its own breaker', () => {
    const adapter = new CircuitBreaker({ threshold: 1 });
    const executors = buildExecutors(target(), [target({ circuitBreaker: adapter })], shared());

    adapter.open();

    expect(executors[0]!.getCircuitState()).toBeUndefined();
    expect(executors[1]!.getCircuitState()).toBe('open');
  });

  it('an incomplete adapter on a fallback target throws invalid_params', () => {
    const incomplete = { assertClosed: vi.fn() } as never;

    expect(() =>
      buildExecutors(target(), [target({ circuitBreaker: incomplete })], shared()),
    ).toThrow(expect.objectContaining({ type: 'invalid_params' }));
  });
});

describe('buildExecutors, limiter only built when configured', () => {
  it('does not construct a RateLimiter when the target has no rateLimit', () => {
    buildExecutors(target(), [], shared());

    expect(rateLimiterCtorSpy).not.toHaveBeenCalled();
  });

  it('constructs a RateLimiter, with the target options, once the target configures rateLimit', () => {
    buildExecutors(target({ rateLimit: { requestsPerMinute: 10 } }), [], shared());

    expect(rateLimiterCtorSpy).toHaveBeenCalledExactlyOnceWith({ requestsPerMinute: 10 });
  });

  it("each target's rateLimit is independent: only the configured target constructs a RateLimiter", () => {
    buildExecutors(target(), [target({ rateLimit: { requestsPerMinute: 5 } }), target()], shared());

    expect(rateLimiterCtorSpy).toHaveBeenCalledOnce();
  });
});
