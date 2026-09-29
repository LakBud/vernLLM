import { describe, expect, it, vi } from 'vitest';

import { type CacheAdapter, type VernLLMEvent } from '../../src/types/index.js';
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

  describe('call context', () => {
    it('does not change the cache key, so a different context still hits the same entry', async () => {
      const { client, create } = createMockClient([jsonResponse({ ok: true })]);
      const llm = new VernLLM({ client, model: 'test', logger: 'silent' });
      const params = (context: { tenantId: string }) => ({
        cacheKey: 'abc',
        ttl: 100,
        call: { systemPrompt: 'sys', userContent: 'hi', context },
      });

      const first = await llm.cachedCall(params({ tenantId: 'A' }));
      const second = await llm.cachedCall(params({ tenantId: 'B' }));

      expect(second).toEqual(first);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("gives each caller's own middleware its own context on a hit, a miss and a join", async () => {
      const { client } = createMockClient([
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return jsonResponse({ ok: true });
        },
      ]);
      const seen: Record<string, unknown> = {};
      const events: VernLLMEvent[] = [];

      const llm = new VernLLM({
        client,
        model: 'test',
        logger: 'silent',
        onEvent: (event) => void events.push(event),
        middleware: [
          {
            name: 'reader',
            wrap: async (_request, next, ctx) => {
              seen[ctx.requestId] = ctx.context;
              return next();
            },
          },
        ],
      });
      const call = (requestId: string, tenantId: string) =>
        llm.cachedCall({
          cacheKey: 'shared',
          ttl: 100,
          call: { userContent: 'hi', requestId, context: { tenantId } },
        });

      // Concurrent: the first is the miss that runs the request, the second joins it.
      await Promise.all([call('leader', 'A'), call('follower', 'B')]);
      // Later: a plain hit.
      await call('hit', 'C');

      expect(seen).toEqual({
        leader: { tenantId: 'A' },
        follower: { tenantId: 'B' },
        hit: { tenantId: 'C' },
      });

      // The shared request ran once, for the leader, so its events carry the leader's context
      // and the follower's is never used for them.
      const sharedEvents = events.filter((event) => event.kind === 'usage');
      expect(
        sharedEvents.every((event) => JSON.stringify(event.context) === '{"tenantId":"A"}'),
      ).toBe(true);
      expect(events.some((event) => JSON.stringify(event.context ?? '').includes('"B"'))).toBe(
        false,
      );
    });

    it('rejects an invalid context without leaving the cache key claimed, so the next call still runs', async () => {
      const { client, create } = createMockClient([jsonResponse({ ok: true })]);
      const llm = new VernLLM({ client, model: 'test', logger: 'silent' });
      const params = (context: unknown) => ({
        cacheKey: 'abc',
        ttl: 100,
        call: { userContent: 'hi', context: context as never },
      });

      await expect(llm.cachedCall(params([1]))).rejects.toMatchObject({ code: 'invalid_context' });
      await expect(llm.cachedCall(params({ tenantId: 'A' }))).resolves.toEqual({ ok: true });

      expect(create).toHaveBeenCalledTimes(1);
    });
  });
});
