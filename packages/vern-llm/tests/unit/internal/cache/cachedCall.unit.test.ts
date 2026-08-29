import { describe, it, expect, expectTypeOf, vi } from 'vitest';

import { isLLMError, type LLMError } from '../../../../src/types/errors.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { createMockClient, jsonResponse } from '../../../helpers.js';

import type {
  CachedCallParams,
  CachedJsonModeDisabledCallParams,
  CachedJsonModeEnabledCallParams,
  CachedStreamCallParams,
  CachedStreamToolCallParams,
  CallMeta,
} from '../../../../src/types/index.js';

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
