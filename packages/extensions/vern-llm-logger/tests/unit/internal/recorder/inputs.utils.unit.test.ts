import { describe, expect, it, vi } from 'vitest';

import { createGuard } from '../../../../src/internal/guard.utils.js';
import {
  pickContext,
  pickUsage,
  runEnrichers,
} from '../../../../src/internal/recorder/inputs.utils.js';

import type { PreDispatchContext } from 'vern-llm';

const ctx = {} as PreDispatchContext;
const recordingLogger = () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('pickContext', () => {
  it('copies only the allowlisted keys', () => {
    expect(
      pickContext({ tenantId: 'acme', secret: 'x', feature: 'chat' }, ['tenantId', 'feature']),
    ).toEqual({
      tenantId: 'acme',
      feature: 'chat',
    });
  });

  it('is undefined when nothing matches, there is no context, or nothing is allowed', () => {
    expect(pickContext({ a: 1 }, ['b'])).toBeUndefined();
    expect(pickContext(undefined, ['a'])).toBeUndefined();
    expect(pickContext({ a: 1 }, [])).toBeUndefined();
  });

  it('keeps falsy values that are present', () => {
    expect(pickContext({ a: 0, b: false, c: null, d: '' }, ['a', 'b', 'c', 'd'])).toEqual({
      a: 0,
      b: false,
      c: null,
      d: '',
    });
  });

  it('ignores inherited keys', () => {
    const context = Object.create({ inherited: 'x' }) as Record<string, never>;
    expect(pickContext(context, ['inherited'])).toBeUndefined();
  });
});

describe('runEnrichers', () => {
  it('merges results left to right, so a later one wins', () => {
    const fields = runEnrichers(
      [() => ({ a: 1, shared: 'first' }), () => ({ b: 2, shared: 'second' })],
      ctx,
      createGuard('silent'),
    );

    expect(fields).toEqual({ a: 1, b: 2, shared: 'second' });
  });

  it('loses only the fields of an enricher that throws', () => {
    const logger = recordingLogger();
    const fields = runEnrichers(
      [
        () => ({ a: 1 }),
        () => {
          throw new Error('broken');
        },
        () => ({ c: 3 }),
      ],
      ctx,
      createGuard(logger),
    );

    expect(fields).toEqual({ a: 1, c: 3 });
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] logger: enrich[1] failed',
      expect.objectContaining({ message: 'broken' }),
    );
  });

  it('passes the call context to each enricher', () => {
    const seen = vi.fn(() => ({ ok: true }));
    runEnrichers([seen], ctx, createGuard('silent'));
    expect(seen).toHaveBeenCalledWith(ctx);
  });

  it('is undefined with no enrichers or nothing returned', () => {
    expect(runEnrichers([], ctx, createGuard('silent'))).toBeUndefined();
    expect(runEnrichers([() => undefined, () => ({})], ctx, createGuard('silent'))).toBeUndefined();
  });

  it('ignores a result that is not an object', () => {
    const fields = runEnrichers(
      [(() => 'text') as never, (() => 5) as never, (() => null) as never, () => ({ a: 1 })],
      ctx,
      createGuard('silent'),
    );
    expect(fields).toEqual({ a: 1 });
  });

  it('never lets __proto__ change the prototype', () => {
    const fields = runEnrichers(
      [() => JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}') as never],
      ctx,
      createGuard('silent'),
    );

    expect(fields).toEqual({ safe: 1 });
    expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('reports a rejecting async enricher instead of leaving it unhandled', async () => {
    const logger = recordingLogger();
    const fields = runEnrichers(
      [(() => Promise.reject(new Error('late'))) as never, () => ({ a: 1 })],
      ctx,
      createGuard(logger),
    );

    expect(fields).toEqual({ a: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] logger: enrich[0] failed',
      expect.objectContaining({ message: 'late' }),
    );
  });
});

describe('pickUsage', () => {
  const usage = {
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    requestId: 'req_1',
    model: 'gpt-4o',
    provider: 'primary',
    usedFallback: false,
    context: { tenantId: 'acme', apiKey: 'sk-secret' },
  };

  it('keeps the token counts and nothing else', () => {
    expect(pickUsage(usage)).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 });
  });

  it('never carries the call context, which the core puts on its usage object', () => {
    expect(JSON.stringify(pickUsage(usage))).not.toContain('sk-secret');
    expect(pickUsage(usage)).not.toHaveProperty('context');
  });

  it('keeps the optional counts that are reported, and skips the rest', () => {
    expect(
      pickUsage({ ...usage, reasoningTokens: 5, cacheReadTokens: 0, cacheWriteTokens: Number.NaN }),
    ).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      reasoningTokens: 5,
      cacheReadTokens: 0,
    });
  });

  it('keeps a reported cache write count', () => {
    expect(pickUsage({ ...usage, cacheWriteTokens: 7 }).cacheWriteTokens).toBe(7);
  });

  it('copies the cache writes by ttl, keeping only counts', () => {
    const byTtl = { '5m': 4, '1h': 'many', bad: Number.POSITIVE_INFINITY } as never;
    const picked = pickUsage({ ...usage, cacheWriteTokensByTtl: byTtl });

    expect(picked.cacheWriteTokensByTtl).toEqual({ '5m': 4 });
    expect(picked.cacheWriteTokensByTtl).not.toBe(byTtl);
  });

  it('never lets a __proto__ ttl change the prototype', () => {
    const byTtl = JSON.parse('{"__proto__": 1, "5m": 2}') as never;
    const picked = pickUsage({ ...usage, cacheWriteTokensByTtl: byTtl });

    expect(picked.cacheWriteTokensByTtl).toEqual({ '5m': 2 });
    expect(Object.getPrototypeOf(picked.cacheWriteTokensByTtl)).toBe(Object.prototype);
  });
});
