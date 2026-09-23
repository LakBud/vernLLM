import { describe, it, expect } from 'vitest';

import { isLLMError } from '../../../../src/types/errors.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { createMockClient, createMockStreamingClient, jsonResponse } from '../../../helpers.js';

import type { LLMClient } from '../../../../src/types/index.js';

type CreateResult = Awaited<ReturnType<LLMClient['chat']['completions']['create']>>;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A provider call that waits on a gate and rejects if its signal aborts. */
function gatedClient() {
  let resolveGate!: (value: CreateResult) => void;
  const gate = new Promise<CreateResult>((resolve) => {
    resolveGate = resolve;
  });
  let providerSignal: AbortSignal | undefined;

  const { client, create } = createMockClient([
    (_params, signal) => {
      providerSignal = signal;
      return new Promise<CreateResult>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        void gate.then(resolve);
      });
    },
  ]);

  return { client, create, resolveGate, getProviderSignal: () => providerSignal };
}

describe('VernLLM.cachedCall, coalesced aborts and deadlines', () => {
  it("a trigger's call.signal abort doesn't fail a joiner", async () => {
    const { client, create, resolveGate } = gatedClient();
    const llm = new VernLLM({ client, model: 'm' });
    const triggerAbort = new AbortController();

    const trigger = llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { userContent: 'hi', signal: triggerAbort.signal },
    });
    await tick();
    const joiner = llm.cachedCall({ cacheKey: 'k', ttl: 60, call: { userContent: 'hi' } });
    await tick();

    triggerAbort.abort();
    await expect(trigger).rejects.toSatisfy((e) => isLLMError(e) && e.type === 'aborted');

    resolveGate(jsonResponse({ ok: true }));
    await expect(joiner).resolves.toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a trigger's deadline doesn't fail a joiner, and the trigger gets deadline_exceeded", async () => {
    const { client, resolveGate } = gatedClient();
    const llm = new VernLLM({ client, model: 'm' });

    const trigger = llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { userContent: 'hi', deadlineMs: 20 },
    });
    await tick();
    const joiner = llm.cachedCall({ cacheKey: 'k', ttl: 60, call: { userContent: 'hi' } });

    await expect(trigger).rejects.toSatisfy(
      (e) => isLLMError(e) && e.type === 'aborted' && e.code === 'deadline_exceeded',
    );

    resolveGate(jsonResponse({ ok: true }));
    await expect(joiner).resolves.toEqual({ ok: true });
  });

  it("a joiner's own abort rejects it right away, before the trigger settles", async () => {
    const { client, resolveGate } = gatedClient();
    const llm = new VernLLM({ client, model: 'm' });
    const joinerAbort = new AbortController();

    const trigger = llm.cachedCall({ cacheKey: 'k', ttl: 60, call: { userContent: 'hi' } });
    await tick();
    const joiner = llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { userContent: 'hi', signal: joinerAbort.signal },
    });
    await tick();

    joinerAbort.abort();
    await expect(joiner).rejects.toSatisfy((e) => isLLMError(e) && e.type === 'aborted');

    resolveGate(jsonResponse({ ok: true }));
    await expect(trigger).resolves.toEqual({ ok: true });
  });

  it('aborts the provider call once every coalesced caller has left', async () => {
    const { client, getProviderSignal } = gatedClient();
    const llm = new VernLLM({ client, model: 'm' });
    const a = new AbortController();
    const b = new AbortController();

    const trigger = llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { userContent: 'hi', signal: a.signal },
    });
    await tick();
    const joiner = llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { userContent: 'hi', signal: b.signal },
    });
    await tick();

    a.abort();
    await expect(trigger).rejects.toBeDefined();
    expect(getProviderSignal()?.aborted).toBe(false);

    b.abort();
    await expect(joiner).rejects.toBeDefined();
    expect(getProviderSignal()?.aborted).toBe(true);
  });

  it('a new caller after everyone left starts fresh work', async () => {
    let calls = 0;
    const { client } = createMockClient([
      (_params, signal) => {
        calls++;
        if (calls > 1) return jsonResponse({ fresh: true });
        return new Promise<CreateResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    ]);
    const llm = new VernLLM({ client, model: 'm' });
    const a = new AbortController();

    const first = llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { userContent: 'hi', signal: a.signal },
    });
    await tick();
    a.abort();
    await expect(first).rejects.toBeDefined();

    await expect(
      llm.cachedCall({ cacheKey: 'k', ttl: 60, call: { userContent: 'hi' } }),
    ).resolves.toEqual({ fresh: true });
  });
});

describe('VernLLM.cachedCall stream: true, coalesced aborts', () => {
  it("a trigger's abort mid stream doesn't fail a joiner", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client, createStream } = createMockStreamingClient([
      () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta' as const, delta: 'Hello, ' };
          await gate;
          yield { type: 'text-delta' as const, delta: 'world!' };
        },
      }),
    ]);
    const llm = new VernLLM({ client, model: 'm' });
    const triggerAbort = new AbortController();

    const trigger = await llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: false, stream: true, signal: triggerAbort.signal },
    });
    const joiner = await llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: false, stream: true },
    });

    triggerAbort.abort();
    await expect(trigger.finalResult).rejects.toSatisfy(
      (e) => isLLMError(e) && e.type === 'aborted',
    );

    release();
    await expect(joiner.finalResult).resolves.toBe('Hello, world!');
    expect(createStream).toHaveBeenCalledTimes(1);
  });
});
