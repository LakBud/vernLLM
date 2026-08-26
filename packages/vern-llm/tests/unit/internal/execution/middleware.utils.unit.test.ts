import { describe, expect, it, vi } from 'vitest';

import {
  assertModelAndResponseFormatUnchanged,
  assertNoDuplicateTools,
  mergePatch,
  middlewareLabel,
  reclassifyMiddlewareThrow,
  resolveEnabled,
  runTransform,
} from '../../../../src/internal/execution/utils/middleware.utils.js';
import { LLMError } from '../../../../src/types/errors.js';

import type { MiddlewareContext } from '../../../../src/types/index.js';
import type { WireCallRequest } from '../../../../src/types/middleware.js';

const baseRequest: WireCallRequest = {
  model: 'gpt-4o',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hi' }],
};

function baseCtx(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
  return {
    requestId: 'req-1',
    requestedProvider: 'primary',
    requestedModel: 'gpt-4o',
    isFallbackAttempt: false,
    attempt: 1,
    capabilities: { supportsJsonObjectMode: true },
    state: { get: () => undefined, set: () => {} },
    own: {},
    ...overrides,
  };
}

const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('middlewareLabel', () => {
  it('uses the name when set', () => {
    expect(middlewareLabel({ name: 'my-mw' }, 3)).toBe('my-mw');
  });

  it('falls back to the array index when unnamed', () => {
    expect(middlewareLabel({}, 2)).toBe('[2]');
  });
});

describe('mergePatch', () => {
  it('is a no-op for an empty patch', () => {
    const { request, patchedFields } = mergePatch(baseRequest, {});
    expect(request).toBe(baseRequest);
    expect(patchedFields).toEqual([]);
  });

  it('overwrites scalar fields', () => {
    const { request, patchedFields } = mergePatch(baseRequest, {
      temperature: 0.9,
      max_tokens: 50,
    });
    expect(request.temperature).toBe(0.9);
    expect(request.max_tokens).toBe(50);
    expect(patchedFields.sort()).toEqual(['max_tokens', 'temperature']);
  });

  it('appends addMessages without clobbering the original list', () => {
    const { request } = mergePatch(baseRequest, {
      addMessages: [{ role: 'user', content: 'appended' }],
    });
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]).toEqual(baseRequest.messages[0]);
    expect(request.messages[1]).toEqual({ role: 'user', content: 'appended' });
  });

  it('two sequential addMessages patches each append rather than overwrite the other', () => {
    const first = mergePatch(baseRequest, { addMessages: [{ role: 'user', content: 'first' }] });
    const second = mergePatch(first.request, {
      addMessages: [{ role: 'user', content: 'second' }],
    });
    expect(second.request.messages.map((m) => m.content)).toEqual(['hi', 'first', 'second']);
  });

  it('addTools appends across two independent patches without clobbering', () => {
    const first = mergePatch(baseRequest, {
      addTools: [
        { type: 'function', function: { name: 'toolA', description: 'a', parameters: {} } },
      ],
    });
    const second = mergePatch(first.request, {
      addTools: [
        { type: 'function', function: { name: 'toolB', description: 'b', parameters: {} } },
      ],
    });
    expect(second.request.tools?.map((t) => t.function.name)).toEqual(['toolA', 'toolB']);
  });

  it('a plain messages/tools replace still fully overwrites, as documented', () => {
    const { request } = mergePatch(baseRequest, {
      messages: [{ role: 'system', content: 'replaced' }],
    });
    expect(request.messages).toEqual([{ role: 'system', content: 'replaced' }]);
  });

  it('copies through a bypassed model/response_format field for the backstop guard to catch', () => {
    const patch = { model: 'sneaky' } as never;
    const { request, patchedFields } = mergePatch(baseRequest, patch);
    expect(request.model).toBe('sneaky');
    expect(patchedFields).toContain('model');
  });
});

describe('assertNoDuplicateTools', () => {
  it('does nothing when there are no tools', () => {
    expect(() => assertNoDuplicateTools(baseRequest, 'mw')).not.toThrow();
  });

  it('does nothing when tool names are unique', () => {
    const request: WireCallRequest = {
      ...baseRequest,
      tools: [
        { type: 'function', function: { name: 'a', description: '', parameters: {} } },
        { type: 'function', function: { name: 'b', description: '', parameters: {} } },
      ],
    };
    expect(() => assertNoDuplicateTools(request, 'mw')).not.toThrow();
  });

  it('throws invalid_params naming the offending middleware on a duplicate', () => {
    const request: WireCallRequest = {
      ...baseRequest,
      tools: [
        { type: 'function', function: { name: 'dup', description: '', parameters: {} } },
        { type: 'function', function: { name: 'dup', description: '', parameters: {} } },
      ],
    };
    try {
      assertNoDuplicateTools(request, 'tool-adder');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LLMError);
      expect((error as LLMError).type).toBe('invalid_params');
      expect((error as LLMError).message).toContain('tool-adder');
      expect((error as LLMError).message).toContain('dup');
    }
  });
});

describe('assertModelAndResponseFormatUnchanged', () => {
  it('does nothing when neither field changed', () => {
    expect(() =>
      assertModelAndResponseFormatUnchanged(baseRequest, { ...baseRequest }, 'mw'),
    ).not.toThrow();
  });

  it('throws invalid_params when model changed', () => {
    expect(() =>
      assertModelAndResponseFormatUnchanged(baseRequest, { ...baseRequest, model: 'other' }, 'mw'),
    ).toThrow(/changed `model`/);
  });

  it('throws invalid_params when response_format changed', () => {
    expect(() =>
      assertModelAndResponseFormatUnchanged(
        baseRequest,
        { ...baseRequest, response_format: { type: 'json_object' } },
        'mw',
      ),
    ).toThrow(/changed `response_format`/);
  });
});

describe('resolveEnabled', () => {
  it('defaults to enabled when unset', async () => {
    const result = await resolveEnabled({}, baseCtx(), 'mw', 5000, logger);
    expect(result).toBe(true);
  });

  it('returns a static boolean as-is', async () => {
    expect(await resolveEnabled({ enabled: false }, baseCtx(), 'mw', 5000, logger)).toBe(false);
    expect(await resolveEnabled({ enabled: true }, baseCtx(), 'mw', 5000, logger)).toBe(true);
  });

  it('awaits an async predicate', async () => {
    const result = await resolveEnabled(
      { enabled: async () => true },
      baseCtx(),
      'mw',
      5000,
      logger,
    );
    expect(result).toBe(true);
  });

  it('treats a throwing predicate as disabled and logs it', async () => {
    const errorLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await resolveEnabled(
      {
        enabled: () => {
          throw new Error('boom');
        },
      },
      baseCtx(),
      'flaky',
      5000,
      errorLogger,
    );
    expect(result).toBe(false);
    expect(errorLogger.error).toHaveBeenCalledTimes(1);
    expect(errorLogger.error.mock.calls[0]![0]).toContain('flaky');
  });

  it('treats a timed-out predicate as disabled', async () => {
    const errorLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await resolveEnabled(
      { enabled: () => new Promise(() => {}) },
      baseCtx(),
      'slow',
      10,
      errorLogger,
    );
    expect(result).toBe(false);
    expect(errorLogger.error).toHaveBeenCalledTimes(1);
  });

  it('a per-middleware timeoutMs overrides the instance middlewareTimeoutMs', async () => {
    const errorLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const start = Date.now();
    const result = await resolveEnabled(
      { enabled: () => new Promise(() => {}), timeoutMs: 15 },
      baseCtx(),
      'slow',
      100000,
      errorLogger,
    );
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result).toBe(false);
  });

  it('timeoutMs <= 0 is treated as unbounded, never rejecting on a timer', async () => {
    const errorLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await resolveEnabled(
      { enabled: () => Promise.resolve(true) },
      baseCtx(),
      'unbounded',
      0,
      errorLogger,
    );
    expect(result).toBe(true);
    expect(errorLogger.error).not.toHaveBeenCalled();
  });
});

describe('reclassifyMiddlewareThrow', () => {
  it('passes an already-built LLMError through with its own type intact', () => {
    const original = new LLMError('rate limited', 'rate_limited');
    const result = reclassifyMiddlewareThrow(original, 'mw');
    expect(result).toBe(original);
  });

  it('passes through a recognizable network-style error with its own classification', () => {
    const netErr = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    const result = reclassifyMiddlewareThrow(netErr, 'mw');
    expect(result.type).not.toBe('unknown');
  });

  it('reclassifies a genuinely unrecognizable throw to invalid_params, naming the middleware', () => {
    const result = reclassifyMiddlewareThrow(new Error('a plain bug'), 'my-middleware');
    expect(result.type).toBe('invalid_params');
    expect(result.code).toBe('middleware_threw');
    expect(result.message).toContain('my-middleware');
    expect(result.retryable).toBe(false);
  });
});

describe('runTransform', () => {
  it('classifies a timed-out transform as a non-retryable middleware_timeout', async () => {
    await expect(
      runTransform(
        { transform: () => new Promise(() => {}) },
        baseRequest,
        baseCtx(),
        'slow-transform',
        10,
      ),
    ).rejects.toMatchObject({
      type: 'timeout',
      code: 'middleware_timeout',
      retryable: false,
    });
  });
});
