import { describe, expect, it, vi } from 'vitest';

import { createStateKey } from '../../../src/types/middleware.js';
import {
  baseCtx,
  baseRequest,
  logger,
} from '../internal/execution/utils/middleware/middleware.helpers.js';

/**
 * Exercises `middleware.helpers.ts` itself, the shared `baseCtx` /
 * `baseRequest` / `logger` every middleware test relies on. The defaults are
 * already imported everywhere, but the default `state` bag's `get` / `set`
 * stubs are never invoked by those tests. Covered directly here instead.
 */
describe('baseRequest', () => {
  it('exposes a minimal user-message request', () => {
    expect(baseRequest).toEqual({
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });
});

describe('baseCtx', () => {
  it('returns the default attempt context when no overrides are given', () => {
    const ctx = baseCtx();

    expect(ctx.stage).toBe('attempt');
    expect(ctx.requestId).toBe('req-1');
    expect(ctx.adapter).toEqual({ name: 'custom' });
    expect(ctx.requestedProvider).toBe('primary');
    expect(ctx.requestedModel).toBe('gpt-4o');
    expect(ctx.isFallbackAttempt).toBe(false);
    expect(ctx.attempt).toBe(1);
    expect(ctx.capabilities).toEqual({ supportsJsonObjectMode: true });
    expect(ctx.own).toEqual({});
    expect(ctx.registeredMiddlewareNames).toEqual([]);
    expect(ctx.transformMiddlewareNames).toEqual([]);
  });

  it('applies overrides over the defaults', () => {
    const ctx = baseCtx({ requestId: 'req-2', attempt: 3, isFallbackAttempt: true });

    expect(ctx.requestId).toBe('req-2');
    expect(ctx.attempt).toBe(3);
    expect(ctx.isFallbackAttempt).toBe(true);
    // Untouched defaults still hold.
    expect(ctx.requestedModel).toBe('gpt-4o');
  });

  it('provides a default state bag whose get returns undefined and set is a no-op', () => {
    const ctx = baseCtx();
    const key = createStateKey<string>('k');

    expect(ctx.state.get(key)).toBeUndefined();
    expect(ctx.state.set(key, 'value')).toBeUndefined();
    // Still undefined: the stub stores nothing.
    expect(ctx.state.get(key)).toBeUndefined();
  });
});

describe('logger', () => {
  it('exposes vitest mocks for debug, warn and error', () => {
    expect(logger.debug).toBeTypeOf('function');
    expect(logger.warn).toBeTypeOf('function');
    expect(logger.error).toBeTypeOf('function');

    logger.debug('d');
    logger.warn('w');
    logger.error('e');

    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('d');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('w');
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith('e');
  });
});
