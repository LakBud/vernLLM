import { describe, expect, it, vi } from 'vitest';

import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse } from '../helpers.js';


describe('cachedCall workflow integration', () => {
  it('does not call underlying function after cache hit', async () => {
    const { client } = createMockClient([
      jsonResponse({ ok: true }),
    ]);

    const llm = new VernLLM({
      client,
      model: 'test',
    });


    const fn = vi.fn(async () => ({
      result: 'value',
    }));


    const first = await llm.cachedCall({
      cacheKey: 'abc',
      ttl: 100,
      fn,
    });


    const second = await llm.cachedCall({
      cacheKey: 'abc',
      ttl: 100,
      fn,
    });


    expect(first).toEqual(second);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});