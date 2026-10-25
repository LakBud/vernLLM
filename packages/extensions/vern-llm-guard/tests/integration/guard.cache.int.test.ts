import { isLLMError } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { keywords, patterns, type Check, type GuardResult } from '../../src/index.js';
import { harness, lastUserText } from '../helpers.js';

const tokenOf = (text: string) => /x[0-9a-f]{6}@redacted\.invalid/.exec(text)?.[0];

/** A cache adapter over a Map that can be shared by two clients. */
function memoryCache() {
  const store = new Map<string, unknown>();
  return {
    store,
    adapter: {
      get: async (key: string) =>
        store.has(key) ? { hit: true, value: store.get(key) } : { hit: false, value: null },
      set: async (key: string, value: unknown) => void store.set(key, value),
    },
  };
}

const cached = (userContent: string, cacheKey = 'k') => ({
  call: { userContent, jsonMode: false as const },
  cacheKey,
  ttl: 60_000,
});

function results(events: { name: string; data: unknown }[]): GuardResult[] {
  return events.filter((event) => event.name === 'guard.result').map((e) => e.data as GuardResult);
}

describe('a call answered from the cache', () => {
  it('is checked again, so a stricter policy applies to a stored answer', async () => {
    const { adapter } = memoryCache();
    const forbid: Check = {
      id: 'leak',
      detect: keywords(['hunter2']),
      action: 'block',
      on: 'output',
    };
    const lax = harness({ checks: [] }, { cache: adapter }, { primary: () => 'password hunter2' });
    const strict = harness({ checks: [forbid] }, { cache: adapter });

    await expect(lax.llm.cachedCall(cached('hi'))).resolves.toBe('password hunter2');
    const error = await strict.llm.cachedCall(cached('hi')).catch((e: unknown) => e);

    expect(strict.primary.calls).toHaveLength(0);
    expect(isLLMError(error) && error.code).toBe('content_blocked');
  });

  it('holds the answer with tokens, never the value the caller sent', async () => {
    const { adapter, store } = memoryCache();
    const { llm } = harness(
      { checks: [{ id: 'pii', detect: patterns(['email']), action: 'redact' }] },
      { cache: adapter },
      { primary: (params) => `write to ${tokenOf(lastUserText(params))}` },
    );

    const answer = await llm.cachedCall(cached('jane@acme.com'));

    expect(answer).toBe('write to jane@acme.com');
    expect(JSON.stringify([...store.values()])).not.toContain('jane@acme.com');
    expect(tokenOf(JSON.stringify([...store.values()]))).toBeDefined();
  });

  it('cannot hand a caller a value it never sent', async () => {
    const { adapter } = memoryCache();
    const { llm } = harness(
      { checks: [{ id: 'pii', detect: patterns(['email']), action: 'redact' }] },
      { cache: adapter },
      { primary: (params) => `write to ${tokenOf(lastUserText(params))}` },
    );

    await llm.cachedCall(cached('jane@acme.com'));
    // The same key, so the stored answer is served, with a token this caller has no value for.
    const second = await llm.cachedCall(cached('bob@other.com'));

    expect(second).not.toContain('jane@acme.com');
    expect(second).not.toContain('bob@other.com');
    expect(tokenOf(second)).toBeDefined();
  });

  it('reports one guard.result for each call', async () => {
    const { adapter } = memoryCache();
    const { llm, events } = harness({ checks: [] }, { cache: adapter });

    await llm.cachedCall(cached('hi'));
    await llm.cachedCall(cached('hi'));

    expect(results(events)).toHaveLength(2);
  });
});
