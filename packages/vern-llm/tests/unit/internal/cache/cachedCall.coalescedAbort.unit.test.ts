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

describe('VernLLM.cachedCall, trigger failing before it starts the shared call', () => {
  it('still starts the shared call for a joiner when the trigger aborts during reservation', async () => {
    const { client, create, resolveGate } = gatedClient();
    const llm = new VernLLM({ client, model: 'm' });
    const triggerAbort = new AbortController();

    const trigger = llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      signal: triggerAbort.signal,
      reserveUsage: ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
        }),
      call: { userContent: 'hi' },
    });
    await tick();
    const joiner = llm.cachedCall({ cacheKey: 'k', ttl: 60, call: { userContent: 'hi' } });
    await tick();

    triggerAbort.abort();
    await expect(trigger).rejects.toSatisfy((e) => isLLMError(e) && e.type === 'aborted');
    await tick();
    expect(create).toHaveBeenCalledTimes(1);

    resolveGate(jsonResponse({ ok: true }));
    await expect(joiner).resolves.toEqual({ ok: true });
  });

  it('fails a joiner with the trigger error when reservation fails for another reason', async () => {
    const { client, create } = gatedClient();
    const llm = new VernLLM({ client, model: 'm' });
    let rejectReserve!: (error: Error) => void;

    const trigger = llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      reserveUsage: () =>
        new Promise<void>((_resolve, reject) => {
          rejectReserve = reject;
        }),
      call: { userContent: 'hi' },
    });
    await tick();
    const joiner = llm.cachedCall({ cacheKey: 'k', ttl: 60, call: { userContent: 'hi' } });
    await tick();

    rejectReserve(new Error('over budget'));

    await expect(trigger).rejects.toSatisfy((e) => isLLMError(e) && e.type === 'quota_exceeded');
    await expect(joiner).rejects.toSatisfy((e) => isLLMError(e) && e.type === 'quota_exceeded');
    expect(create).not.toHaveBeenCalled();
  });

  it('honors a top level signal and call.signal together', async () => {
    const { client } = gatedClient();
    const llm = new VernLLM({ client, model: 'm' });
    const top = new AbortController();
    const inner = new AbortController();

    const pending = llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      signal: top.signal,
      call: { userContent: 'hi', signal: inner.signal },
    });
    await tick();
    top.abort();

    await expect(pending).rejects.toSatisfy((e) => isLLMError(e) && e.type === 'aborted');
  });
});

describe('VernLLM.cachedCall stream: true, trigger chunks', () => {
  it("stops the trigger's chunk iteration at its own abort", async () => {
    const { client } = createMockStreamingClient([
      () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta' as const, delta: 'Hello' };
          await new Promise(() => {});
        },
      }),
    ]);
    const llm = new VernLLM({ client, model: 'm' });
    const controller = new AbortController();

    const { chunks, finalResult } = await llm.cachedCall({
      cacheKey: 'k',
      ttl: 60,
      call: { userContent: 'hi', jsonMode: false, stream: true, signal: controller.signal },
    });
    finalResult.catch(() => {});
    const iterator = chunks[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'text-delta', delta: 'Hello' },
    });
    const next = iterator.next();
    controller.abort();

    await expect(next).rejects.toSatisfy((e) => isLLMError(e) && e.type === 'aborted');
  });
});
