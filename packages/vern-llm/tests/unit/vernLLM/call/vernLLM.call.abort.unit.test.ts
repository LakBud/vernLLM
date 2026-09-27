import { describe, expect, it, vi } from 'vitest';

import { type CallResult } from '../../../../src/types/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { createMockClient, jsonResponse } from '../../../helpers.js';

describe('VernLLM.call, abort handling', () => {
  it('throws LLMError(aborted) if the signal is already aborted', async () => {
    const { client, create } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });
    const controller = new AbortController();
    controller.abort();

    await expect(
      llm.call({ systemPrompt: 's', userContent: 'u', signal: controller.signal }),
    ).rejects.toMatchObject({ type: 'aborted' });
    expect(create).not.toHaveBeenCalled();
  });

  it('throws LLMError(aborted) if the signal aborts mid-flight', async () => {
    const controller = new AbortController();
    const { client } = createMockClient([
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by caller')));
        }),
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 2 });

    const promise = llm.call({ systemPrompt: 's', userContent: 'u', signal: controller.signal });
    const assertion = expect(promise).rejects.toMatchObject({ type: 'aborted' });
    controller.abort();
    await assertion;
  });
});

describe('VernLLM.call, deadlineMs', () => {
  it('rejects with code deadline_exceeded when deadlineMs elapses before the target resolves', async () => {
    const { client, create } = createMockClient([
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by caller')));
        }),
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    await expect(
      llm.call({ systemPrompt: 's', userContent: 'u', deadlineMs: 10 }),
    ).rejects.toMatchObject({ type: 'aborted', code: 'deadline_exceeded' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('resolves normally, and clears the deadline timer specifically, when deadlineMs is longer than the call takes', async () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    // The per-attempt withTimeout timer also calls clearTimeout on every
    // call regardless of deadlineMs, so asserting clearTimeout was merely
    // called at all wouldn't actually prove the deadline timer specifically
    // was cleared. Capture the handle setTimeout returns for the 60_000ms
    // deadline call and assert clearTimeout was called with that exact
    // handle, distinguishing it from the instance's default 25_000ms
    // per-attempt timer.
    const setSpy = vi.spyOn(global, 'setTimeout');
    const clearSpy = vi.spyOn(global, 'clearTimeout');

    const result = await llm.call({
      systemPrompt: 's',
      userContent: 'u',
      deadlineMs: 60_000,
    });

    expect(result).toEqual({ ok: true });

    const deadlineTimerCall = setSpy.mock.calls.find(([, delay]) => delay === 60_000);
    expect(deadlineTimerCall).toBeDefined();
    const deadlineTimerHandle =
      setSpy.mock.results[setSpy.mock.calls.indexOf(deadlineTimerCall!)]!.value;

    expect(clearSpy).toHaveBeenCalledWith(deadlineTimerHandle);

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('does not stamp deadline_exceeded when a caller signal aborts before the deadline', async () => {
    const controller = new AbortController();
    const { client } = createMockClient([
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by caller')));
        }),
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    const promise = llm.call({
      systemPrompt: 's',
      userContent: 'u',
      deadlineMs: 60_000,
      signal: controller.signal,
    });
    const assertion = expect(promise).rejects.toMatchObject({
      type: 'aborted',
      code: undefined,
    });
    controller.abort();
    await assertion;
  });

  it('stamps deadline_exceeded when the deadline fires before a caller-supplied signal aborts', async () => {
    const controller = new AbortController();
    const { client, create } = createMockClient([
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by caller')));
        }),
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0 });

    await expect(
      llm.call({
        systemPrompt: 's',
        userContent: 'u',
        deadlineMs: 10,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ type: 'aborted', code: 'deadline_exceeded' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('cuts a fallback chain short once deadlineMs elapses, never reaching the fallback target', async () => {
    const primary = createMockClient([
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by caller')));
        }),
    ]);
    const fallback = createMockClient([jsonResponse({ ok: true })]);

    const llm = new VernLLM({
      client: primary.client,
      model: 'm',
      maxRetries: 0,
      fallback: { client: fallback.client, model: 'm2' },
    });

    await expect(
      llm.call({ systemPrompt: 's', userContent: 'u', deadlineMs: 10 }),
    ).rejects.toMatchObject({ type: 'aborted', code: 'deadline_exceeded' });
    expect(fallback.create).not.toHaveBeenCalled();
  });

  it('creates no controller or timer when deadlineMs is omitted', async () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });

    const setSpy = vi.spyOn(global, 'setTimeout');
    await llm.call({ systemPrompt: 's', userContent: 'u' });

    // withTimeout still schedules its own per-attempt timer (unrelated to
    // deadlineMs), so the assertion is on its duration: the instance's
    // default timeoutMs (25000), never a deadline timer, since none was
    // requested.
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 25_000);
    setSpy.mockRestore();
  });
});

describe('VernLLM.call, abort during wrap vs breaker trial slot', () => {
  it('never claims the half-open trial slot when the signal aborts inside wrap, before assertBreakerClosed runs', async () => {
    const controller = new AbortController();

    const abortDuringWrap = {
      // Scoped to only the one call that passes `controller.signal`, so
      // the unrelated breaker-tripping call and the final trial call are
      // untouched by this middleware entirely, not merely by an abort
      // that happens to be a no-op for them.
      enabled: (ctx: { signal?: AbortSignal }) => ctx.signal === controller.signal,
      wrap: async (_request: unknown, next: () => Promise<CallResult>) => {
        controller.abort();
        return next();
      },
    };

    const { client, create } = createMockClient([new Error('boom'), jsonResponse({ ok: true })]);
    const transitions: string[] = [];

    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: {
        threshold: 1,
        cooldownMs: 0,
        onStateChange: (from, to) => transitions.push(`${from}->${to}`),
      },
      middleware: [abortDuringWrap],
    });

    // 1) One real failure trips the breaker open. No signal is aborted
    // on this call, so `wrap` firing `controller.abort()` here is
    // harmless: nothing downstream reads `controller.signal` yet.
    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).rejects.toMatchObject({
      type: 'unknown',
    });
    expect(transitions).toEqual(['closed->open']);

    // 2) A second call whose signal is aborted by the `wrap` middleware,
    // before `assertBreakerClosed` is ever reached. It must fail with
    // 'aborted', never dispatch to the provider, and must not touch the
    // breaker at all.
    await expect(
      llm.call({ systemPrompt: 's', userContent: 'u', signal: controller.signal }),
    ).rejects.toMatchObject({ type: 'aborted' });
    expect(create).toHaveBeenCalledTimes(1);
    // No open->half-open transition means no trial slot was claimed.
    expect(transitions).toEqual(['closed->open']);

    // 3) A genuine, non-aborted call still gets to be the real half-open
    // trial (not rejected as 'circuit_trial_in_flight') and closes the
    // circuit on success, proving step 2 never consumed the trial slot.
    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).resolves.toEqual({
      ok: true,
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(llm.getCircuitState()).toBe('closed');
  });
});
