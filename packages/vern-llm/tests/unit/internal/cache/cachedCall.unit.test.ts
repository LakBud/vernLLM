import { describe, it, expect, vi } from 'vitest';

import { VernLLM } from '../../../../src/vernLLM.js';
import { createMockClient } from '../../../helpers.js';

import type { CachedCallParams } from '../../../../src/types/index.js';

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
    const { client } = createMockClient([new Error('fail')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    // `call`'s type no longer permits reserveUsage/refundUsage (see
    // CachedCallParams), so a well-typed caller can't construct this
    await expect(
      llm.cachedCall({
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
      } as unknown as CachedCallParams<string>),
    ).rejects.toThrow(/reserveUsage.*refundUsage.*cachedCall ignores them/i);

    // Nothing should run at all: this is a validation failure caught
    // before any reservation, request, or refund is attempted.
    expect(outerReserve).not.toHaveBeenCalled();
    expect(outerRefund).not.toHaveBeenCalled();
    expect(innerReserve).not.toHaveBeenCalled();
    expect(innerRefund).not.toHaveBeenCalled();
  });
});
