import { describe, it, expect } from 'vitest';

import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse, textResponse } from '../helpers.js';

// `deriveCacheKey` hashes the exact wire request `previewRequest` would
// build for `params`, so it changes whenever anything that actually
// reaches the provider changes, and stays stable when nothing does.

describe('VernLLM.deriveCacheKey', () => {
  it('is a pure function of params: same params derive the same key', () => {
    const { client } = createMockClient([textResponse('x')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const a = llm.deriveCacheKey({ userContent: 'hi' });
    const b = llm.deriveCacheKey({ userContent: 'hi' });

    expect(a).toBe(b);
  });

  it('changes when the prompt changes', () => {
    const { client } = createMockClient([textResponse('x')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const a = llm.deriveCacheKey({ userContent: 'hi' });
    const b = llm.deriveCacheKey({ userContent: 'bye' });

    expect(a).not.toBe(b);
  });

  it('changes when temperature changes, the exact edge a hand-picked cacheKey can miss', () => {
    const { client } = createMockClient([textResponse('x')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const a = llm.deriveCacheKey({ userContent: 'hi', temperature: 0.2 });
    const b = llm.deriveCacheKey({ userContent: 'hi', temperature: 0.9 });

    expect(a).not.toBe(b);
  });

  it('changes when a per-call model override changes', () => {
    const { client } = createMockClient([textResponse('x')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const a = llm.deriveCacheKey({ userContent: 'hi', model: 'gpt-4o' });
    const b = llm.deriveCacheKey({ userContent: 'hi', model: 'gpt-4o-mini' });

    expect(a).not.toBe(b);
  });

  it('changes when maxTokens changes', () => {
    const { client } = createMockClient([textResponse('x')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const a = llm.deriveCacheKey({ userContent: 'hi', maxTokens: 256 });
    const b = llm.deriveCacheKey({ userContent: 'hi', maxTokens: 1024 });

    expect(a).not.toBe(b);
  });

  it('changes when tools change', () => {
    const { client } = createMockClient([textResponse('x')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const tool = {
      name: 'get_weather',
      description: 'x',
      parameters: { type: 'object', properties: {}, required: [] },
    };

    const a = llm.deriveCacheKey({ userContent: 'hi' });
    const b = llm.deriveCacheKey({ userContent: 'hi', tools: [tool] });

    expect(a).not.toBe(b);
  });

  it('stays the same across two different, functionally-irrelevant signals', () => {
    // An AbortSignal doesn't change what the provider would return, so
    // it shouldn't be part of the derived key, unlike prompt/model/temp.
    const { client } = createMockClient([textResponse('x')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const a = llm.deriveCacheKey({ userContent: 'hi', signal: new AbortController().signal });
    const b = llm.deriveCacheKey({ userContent: 'hi', signal: new AbortController().signal });

    expect(a).toBe(b);
  });

  it('stays the same across two different requestIds', () => {
    const { client } = createMockClient([textResponse('x')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const a = llm.deriveCacheKey({ userContent: 'hi', requestId: 'req-1' });
    const b = llm.deriveCacheKey({ userContent: 'hi', requestId: 'req-2' });

    expect(a).toBe(b);
  });

  it('produces a wr_-prefixed, fixed-length hex key', () => {
    const { client } = createMockClient([textResponse('x')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const key = llm.deriveCacheKey({ userContent: 'hi' });

    expect(key).toMatch(/^wr_[0-9a-f]{8}$/);
  });

  it("the derived key can be passed straight through as cachedCall's cacheKey", async () => {
    const { client, create } = createMockClient([jsonResponse('sunny')]);
    const llm = new VernLLM({ client, model: 'test-model' });

    const params = { userContent: 'weather?' } as const;
    const cacheKey = llm.deriveCacheKey(params);

    const first = await llm.cachedCall({ cacheKey, ttl: 60, call: params });
    const second = await llm.cachedCall({ cacheKey, ttl: 60, call: params });

    expect(first).toBe('sunny');
    expect(second).toBe('sunny');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
