import { describe, it, expect, expectTypeOf, vi } from 'vitest';

import { isLLMError, type LLMError } from '../../../../src/types/errors.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import {
  createMockClient,
  createMockStreamingClient,
  jsonResponse,
  textResponse,
} from '../../../helpers.js';
import { targetChain } from '../../../integration/middleware/middleware.int.helpers.js';

import type {
  CachedCallParams,
  CachedConditionalToolCallParams,
  CachedJsonModeDisabledCallParams,
  CachedJsonModeEnabledCallParams,
  CachedStreamCallParams,
  CachedStreamConditionalToolCallParams,
  CachedStreamJsonModeDisabledCallParams,
  CachedStreamJsonModeEnabledCallParams,
  CachedStreamToolCallParams,
  CachedToolCallParams,
  CallMeta,
  LLMRequestShape,
  MiddlewareStateEntry,
  VernLLMMiddleware,
} from '../../../../src/types/index.js';
import type { ToolDefinition } from '../../../../src/types/tools.js';

type WeatherTool = ToolDefinition<'getWeather', { city: string }>;

describe('CachedJsonModeDisabledCallParams/CachedJsonModeEnabledCallParams, reserveUsage/refundUsage exclusion', () => {
  it('omits reserveUsage/refundUsage from `call`, same as the non-jsonMode aliases', () => {
    expectTypeOf<CachedJsonModeDisabledCallParams['call']>().not.toHaveProperty('reserveUsage');
    expectTypeOf<CachedJsonModeDisabledCallParams['call']>().not.toHaveProperty('refundUsage');
    expectTypeOf<CachedJsonModeEnabledCallParams['call']>().not.toHaveProperty('reserveUsage');
    expectTypeOf<CachedJsonModeEnabledCallParams['call']>().not.toHaveProperty('refundUsage');
  });
});

describe('CachedStreamCallParams/CachedStreamToolCallParams, reserveUsage/refundUsage exclusion', () => {
  it('omits reserveUsage/refundUsage from `call`, same as the non-streaming aliases', () => {
    expectTypeOf<CachedStreamCallParams<string>['call']>().not.toHaveProperty('reserveUsage');
    expectTypeOf<CachedStreamCallParams<string>['call']>().not.toHaveProperty('refundUsage');
    expectTypeOf<CachedStreamToolCallParams<string>['call']>().not.toHaveProperty('reserveUsage');
    expectTypeOf<CachedStreamToolCallParams<string>['call']>().not.toHaveProperty('refundUsage');
  });
});

describe('LLMRequestShape, reserveUsage/refundUsage exclusion', () => {
  it('the base shape itself has no reserveUsage/refundUsage, since CallParams adds those via UsageHooks', () => {
    expectTypeOf<LLMRequestShape<string>>().not.toHaveProperty('reserveUsage');
    expectTypeOf<LLMRequestShape<string>>().not.toHaveProperty('refundUsage');
  });

  it('the remaining conditional-tool and JSON-mode cached variants exclude them too', () => {
    expectTypeOf<CachedConditionalToolCallParams<string>['call']>().not.toHaveProperty(
      'reserveUsage',
    );
    expectTypeOf<CachedConditionalToolCallParams<string>['call']>().not.toHaveProperty(
      'refundUsage',
    );
    expectTypeOf<CachedStreamConditionalToolCallParams<string>['call']>().not.toHaveProperty(
      'reserveUsage',
    );
    expectTypeOf<CachedStreamConditionalToolCallParams<string>['call']>().not.toHaveProperty(
      'refundUsage',
    );
    expectTypeOf<CachedStreamJsonModeDisabledCallParams['call']>().not.toHaveProperty(
      'reserveUsage',
    );
    expectTypeOf<CachedStreamJsonModeEnabledCallParams['call']>().not.toHaveProperty('refundUsage');
  });
});

describe('LLMRequestShape, Tools generic preservation', () => {
  it("carries the supplied Tools generic through to `call.tools`'s element type on the tool-enabled cached variants", () => {
    expectTypeOf<
      CachedToolCallParams<string, [WeatherTool]>['call']['tools'][number]
    >().toEqualTypeOf<WeatherTool>();
    expectTypeOf<
      CachedStreamToolCallParams<string, [WeatherTool]>['call']['tools'][number]
    >().toEqualTypeOf<WeatherTool>();
  });
});

describe('VernLLM.cachedCall, reserveUsage/refundUsage dedup', () => {
  it('reserves and refunds exactly once when only the top-level hooks are provided', async () => {
    const reserveUsage = vi.fn();
    const refundUsage = vi.fn();
    const { client } = createMockClient([new Error('fail')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    await llm
      .cachedCall({
        cacheKey: 'k',
        ttl: 60,
        call: { systemPrompt: 's', userContent: 'u' },
        reserveUsage,
        refundUsage,
      })
      .catch(() => {});

    expect(reserveUsage).toHaveBeenCalledTimes(1);
    expect(refundUsage).toHaveBeenCalledTimes(1);
  });

  it('throws instead of silently ignoring reserveUsage/refundUsage set on the inner call object', async () => {
    const outerReserve = vi.fn();
    const outerRefund = vi.fn();
    const innerReserve = vi.fn();
    const innerRefund = vi.fn();
    const { client, create } = createMockClient([new Error('fail')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    // `call`'s type no longer permits reserveUsage/refundUsage (see
    // CachedCallParams), so a well-typed caller can't construct this
    let caught: unknown;
    try {
      await llm.cachedCall({
        cacheKey: 'k',
        ttl: 60,
        call: {
          systemPrompt: 's',
          userContent: 'u',
          reserveUsage: innerReserve,
          refundUsage: innerRefund,
        },
        reserveUsage: outerReserve,
        refundUsage: outerRefund,
      } as unknown as CachedCallParams<string>);
    } catch (err) {
      caught = err;
    }

    expect(isLLMError(caught)).toBe(true);
    expect((caught as LLMError).type).toBe('invalid_params');
    expect((caught as LLMError).message).toMatch(
      /reserveUsage.*refundUsage.*cachedCall ignores them/i,
    );

    // Nothing should run at all: this is a validation failure caught
    // before any reservation, request, or refund is attempted.
    expect(outerReserve).not.toHaveBeenCalled();
    expect(outerRefund).not.toHaveBeenCalled();
    expect(innerReserve).not.toHaveBeenCalled();
    expect(innerRefund).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('VernLLM.cachedCall, call.meta out-parameter', () => {
  it('sets meta.current on a cache miss trigger', async () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });
    const meta: { current?: CallMeta } = {};

    await llm.cachedCall({ cacheKey: 'k', ttl: 60, call: { userContent: 'hi', meta } });

    expect(meta.current).toMatchObject({ provider: 'primary', model: 'm', fallbackIndex: -1 });
  });

  it('leaves meta.current undefined on a true cache hit, since nothing was spent', async () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    await llm.cachedCall({ cacheKey: 'k', ttl: 60, call: { userContent: 'hi' } });

    const hitMeta: { current?: CallMeta } = {};
    await llm.cachedCall({ cacheKey: 'k', ttl: 60, call: { userContent: 'hi', meta: hitMeta } });

    expect(hitMeta.current).toBeUndefined();
  });

  it("also sets a concurrent joiner's own meta.current, not just the trigger's", async () => {
    let resolveFn!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      resolveFn = resolve;
    });
    const { client } = createMockClient([() => gate as Promise<ReturnType<typeof jsonResponse>>]);
    const llm = new VernLLM({ client, model: 'm' });

    const triggerMeta: { current?: CallMeta } = {};
    const joinerMeta: { current?: CallMeta } = {};

    const trigger = llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { userContent: 'hi', meta: triggerMeta },
    });
    await Promise.resolve();
    const joiner = llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { userContent: 'hi', meta: joinerMeta },
    });

    resolveFn(jsonResponse({ ok: true }));
    await Promise.all([trigger, joiner]);

    expect(triggerMeta.current).toMatchObject({ provider: 'primary', model: 'm' });
    expect(joinerMeta.current).toEqual(triggerMeta.current);
  });

  it("does not set a coalesced joiner's meta.current when the shared call fails", async () => {
    let rejectFn!: (error: Error) => void;
    const gate = new Promise((_resolve, reject) => {
      rejectFn = reject;
    });
    const { client } = createMockClient([() => gate as Promise<ReturnType<typeof jsonResponse>>]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    const triggerMeta: { current?: CallMeta } = {};
    const joinerMeta: { current?: CallMeta } = {};

    const trigger = llm
      .cachedCall({ cacheKey: 'k', ttl: 60, call: { userContent: 'hi', meta: triggerMeta } })
      .catch(() => 'failed');
    await Promise.resolve();
    const joiner = llm
      .cachedCall({ cacheKey: 'k', ttl: 60, call: { userContent: 'hi', meta: joinerMeta } })
      .catch(() => 'failed');

    rejectFn(new Error('boom'));
    await Promise.all([trigger, joiner]);

    expect(triggerMeta.current).toBeUndefined();
    expect(joinerMeta.current).toBeUndefined();
  });
});

describe('VernLLM.cachedCall, context', () => {
  it('accepts a context inside `call`', () => {
    expectTypeOf<CachedJsonModeDisabledCallParams['call']>().toHaveProperty('context');
    expectTypeOf<LLMRequestShape['context']>().toEqualTypeOf<
      { readonly [key: string]: import('../../../../src/types/index.js').JsonValue } | undefined
    >();
  });

  it('rejects an invalid context with invalid_context before touching the cache or the provider', async () => {
    const { client, create } = createMockClient([jsonResponse({ ok: true })]);
    const cache = { get: vi.fn(), set: vi.fn(), resolveKey: vi.fn() };
    const llm = new VernLLM({ client, model: 'test-model', cache: cache as never });

    await expect(
      llm.cachedCall({
        cacheKey: 'k',
        ttl: 100,
        call: { userContent: 'hi', context: 'nope' as never },
      }),
    ).rejects.toMatchObject({ type: 'invalid_params', code: 'invalid_context' });

    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.resolveKey).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('VernLLM.cachedCall, state', () => {
  it('accepts a state inside `call`', () => {
    expectTypeOf<CachedJsonModeDisabledCallParams['call']>().toHaveProperty('state');
    expectTypeOf<LLMRequestShape['state']>().toEqualTypeOf<
      readonly MiddlewareStateEntry[] | undefined
    >();
  });

  it('rejects an invalid state with invalid_params before touching the cache or the provider', async () => {
    const { client, create } = createMockClient([jsonResponse({ ok: true })]);
    const cache = { get: vi.fn(), set: vi.fn(), resolveKey: vi.fn() };
    const llm = new VernLLM({ client, model: 'test-model', cache: cache as never });

    await expect(
      llm.cachedCall({
        cacheKey: 'k',
        ttl: 100,
        call: { userContent: 'hi', state: 'nope' as never },
      }),
    ).rejects.toMatchObject({ type: 'invalid_params' });

    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.resolveKey).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('VernLLM.cachedCall, targets', () => {
  const call = { userContent: 'hi', jsonMode: false as const };

  it('accepts targets inside `call`', () => {
    expectTypeOf<CachedJsonModeDisabledCallParams['call']>().toHaveProperty('targets');
    expectTypeOf<LLMRequestShape['targets']>().toEqualTypeOf<readonly string[] | undefined>();
  });

  it.each([
    ['an unknown name', ['nope'], 'unknown_target'],
    ['an empty order', [], 'no_eligible_targets'],
    ['a repeated name', ['b', 'b'], 'no_eligible_targets'],
  ])(
    'rejects %s with its own code before touching the cache or any provider',
    async (_label, targets, code) => {
      const chain = targetChain([textResponse('p')], [textResponse('b')], [textResponse('c')]);
      const cache = { get: vi.fn(), set: vi.fn(), resolveKey: vi.fn() };
      const llm = new VernLLM({ ...chain.options, cache: cache as never });

      await expect(
        llm.cachedCall({ cacheKey: 'k', ttl: 100, call: { ...call, targets } }),
      ).rejects.toMatchObject({ type: 'invalid_params', code });

      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.resolveKey).not.toHaveBeenCalled();
      expect(chain.primary.create).not.toHaveBeenCalled();
      expect(chain.b.create).not.toHaveBeenCalled();
      expect(chain.c.create).not.toHaveBeenCalled();
    },
  );

  it('runs the requested order on a miss, reporting the position that answered', async () => {
    const chain = targetChain(
      [textResponse('from primary')],
      [textResponse('from b')],
      [textResponse('from c')],
    );
    const llm = new VernLLM(chain.options);
    const meta: { current?: CallMeta } = {};

    await expect(
      llm.cachedCall({ cacheKey: 'k', ttl: 60, call: { ...call, targets: ['c', 'b'], meta } }),
    ).resolves.toBe('from c');

    expect(chain.primary.create).not.toHaveBeenCalled();
    expect(chain.b.create).not.toHaveBeenCalled();
    expect(meta.current).toMatchObject({ provider: 'c', fallbackIndex: 1, position: 0 });
  });

  it('runs the order a wrap leaves, once, since cachedCall wraps the whole logical call', async () => {
    const chain = targetChain(
      [textResponse('from primary')],
      [textResponse('from b')],
      [textResponse('from c')],
    );
    let wraps = 0;
    const narrow: VernLLMMiddleware = {
      name: 'narrow',
      wrap: (_request, next) => {
        wraps++;
        return next({ targets: ['b'] });
      },
    };

    const llm = new VernLLM({ ...chain.options, middleware: [narrow] });

    await expect(
      llm.cachedCall({ cacheKey: 'k', ttl: 60, call: { ...call, targets: ['c', 'b'] } }),
    ).resolves.toBe('from b');

    expect(wraps).toBe(1);
    expect(chain.c.create).not.toHaveBeenCalled();
    expect(chain.b.create).toHaveBeenCalledTimes(1);
  });

  it("ignores a coalesced follower's targets: the shared call runs the one that started it", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const chain = targetChain(
      [textResponse('from primary')],
      [() => gate as Promise<ReturnType<typeof textResponse>>],
      [textResponse('from c')],
    );
    const llm = new VernLLM(chain.options);
    const starterMeta: { current?: CallMeta } = {};
    const followerMeta: { current?: CallMeta } = {};

    const starter = llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { ...call, targets: ['b'], meta: starterMeta },
    });
    await Promise.resolve();
    const follower = llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { ...call, targets: ['c'], meta: followerMeta },
    });

    release(textResponse('from b'));

    await expect(Promise.all([starter, follower])).resolves.toEqual(['from b', 'from b']);
    expect(chain.c.create).not.toHaveBeenCalled();
    expect(followerMeta.current).toEqual(starterMeta.current);
    expect(starterMeta.current).toMatchObject({ provider: 'b' });
  });

  it('does not make targets part of the cache key, so a hit is served whatever order asks for it', async () => {
    const chain = targetChain([textResponse('p')], [textResponse('from b')], [textResponse('c')]);
    const llm = new VernLLM(chain.options);

    await llm.cachedCall({ cacheKey: 'k', ttl: 60, call: { ...call, targets: ['b'] } });
    await expect(
      llm.cachedCall({ cacheKey: 'k', ttl: 60, call: { ...call, targets: ['c'] } }),
    ).resolves.toBe('from b');

    expect(chain.c.create).not.toHaveBeenCalled();
    expect(chain.b.create).toHaveBeenCalledTimes(1);
  });

  it('runs the requested order for a streamed call too', async () => {
    const primary = createMockStreamingClient([[{ type: 'text-delta', delta: 'from primary' }]]);
    const other = createMockStreamingClient([[{ type: 'text-delta', delta: 'from other' }]]);
    const llm = new VernLLM({
      client: primary.client,
      model: 'primary-model',
      name: 'primary',
      logger: 'silent',
      fallback: { client: other.client, model: 'other-model', name: 'other' },
    });

    const { finalResult } = await llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { ...call, stream: true, targets: ['other'] },
    });

    await expect(finalResult).resolves.toBe('from other');
    expect(primary.calls).toHaveLength(0);
    expect(other.calls).toHaveLength(1);
  });
});
