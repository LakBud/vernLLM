import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildExecutors,
  type ExecutorFactoryShared,
} from '../../../src/internal/executorFactory.js';
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
