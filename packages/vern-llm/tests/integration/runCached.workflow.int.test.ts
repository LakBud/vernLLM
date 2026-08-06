import { describe, expect, it, vi } from 'vitest';

import { type CacheAdapter } from '../../src/types/index.js';
import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse } from '../helpers.js';

describe('cachedCall workflow integration', () => {
  it('does not call underlying LLM after cache hit', async () => {
    const { client, create } = createMockClient([jsonResponse({ ok: true })]);

    const llm = new VernLLM({
      client,
      model: 'test',
    });

    const callParams = {
      cacheKey: 'abc',
      ttl: 100,
      call: { systemPrompt: 'sys', userContent: 'hi' },
    };

    const first = await llm.cachedCall(callParams);
    const second = await llm.cachedCall(callParams);

    expect(first).toEqual(second);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('allows deleting a cached entry so the next call recomputes', async () => {
    const { client, create } = createMockClient([
      jsonResponse({ ok: true }),
      jsonResponse({ ok: false }),
    ]);

    const llm = new VernLLM({
      client,
      model: 'test',
    });

    const callParams = {
      cacheKey: 'abc',
      ttl: 100,
      call: { systemPrompt: 'sys', userContent: 'hi' },
    };

    const first = await llm.cachedCall(callParams);

    await llm.deleteCache('abc');

    const second = await llm.cachedCall(callParams);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not fail when cache adapter does not implement delete', async () => {
    const cache: CacheAdapter = {
      get: vi.fn(async () => ({ hit: false, value: null })),
      set: vi.fn(async () => {}),
    };

    const llm = new VernLLM({
      client: createMockClient([]).client,
      model: 'm',
      cache,
    });

    await expect(llm.deleteCache('k1')).resolves.toBeUndefined();
  });
});
