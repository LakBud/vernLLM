import { describe, it, expect, vi } from 'vitest';

import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient } from './../helpers.js';

describe('VernLLM.cachedCall — reserveUsage/refundUsage dedup', () => {
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

  it('ignores reserveUsage/refundUsage set on the inner call object — top-level hooks win, no double reservation', async () => {
    const outerReserve = vi.fn();
    const outerRefund = vi.fn();
    const innerReserve = vi.fn();
    const innerRefund = vi.fn();
    const { client } = createMockClient([new Error('fail')]);
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0, logger });

    await llm
      .cachedCall({
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
      })
      .catch(() => {});

    expect(outerReserve).toHaveBeenCalledTimes(1);
    expect(outerRefund).toHaveBeenCalledTimes(1);
    expect(innerReserve).not.toHaveBeenCalled();
    expect(innerRefund).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ignored by cachedCall'));
  });
});
