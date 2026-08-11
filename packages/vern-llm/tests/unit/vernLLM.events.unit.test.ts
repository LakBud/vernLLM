import { describe, it, expect, vi } from 'vitest';

import { type VernLLMEvent } from '../../src/types/index.js';
import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse } from '../helpers.js';

describe('VernLLM, onEvent: retry', () => {
  it('fires a "retry" event before each backoff wait, with the upcoming attempt number', async () => {
    const onEvent = vi.fn();
    const { client } = createMockClient([
      new Error('a'),
      new Error('b'),
      jsonResponse({ ok: true }),
    ]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 2,
      baseDelayMs: 0,
      onEvent,
    });

    await llm.call({ userContent: 'u' });

    const retryEvents = onEvent.mock.calls
      .map((c) => c[0] as VernLLMEvent)
      .filter((e) => e.kind === 'retry');

    expect(retryEvents).toHaveLength(2);
    expect(retryEvents[0]).toMatchObject({
      kind: 'retry',
      provider: 'primary',
      model: 'm',
      attempt: 1,
      maxRetries: 2,
      retryAfterHonored: false,
    });
    expect(retryEvents[1]).toMatchObject({ kind: 'retry', attempt: 2, maxRetries: 2 });
  });

  it('does not fire a "retry" event on the first attempt, or at all when the call never retries', async () => {
    const onEvent = vi.fn();
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', onEvent });

    await llm.call({ userContent: 'u' });

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('marks retryAfterHonored true when a Retry-After delay was used', async () => {
    const onEvent = vi.fn();

    class FakeApiError extends Error {
      status = 429;
      headers = { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '1' : null) };
    }

    const { client } = createMockClient([
      new FakeApiError('rate limited'),
      jsonResponse({ ok: true }),
    ]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, onEvent });

    await llm.call({ userContent: 'u' });

    const retryEvents = onEvent.mock.calls
      .map((c) => c[0] as VernLLMEvent)
      .filter((e) => e.kind === 'retry');
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]).toMatchObject({ retryAfterHonored: true, delayMs: 1000 });
  });

  it('carries the configured provider name (from the `name` option) on every event', async () => {
    const onEvent = vi.fn();
    const { client } = createMockClient([new Error('a'), jsonResponse({ ok: true })]);
    const llm = new VernLLM({
      client,
      model: 'm',
      name: 'openai',
      maxRetries: 1,
      baseDelayMs: 0,
      onEvent,
    });

    await llm.call({ userContent: 'u' });

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai' }));
  });

  it('reports the per-call `model` override, not the instance default, when one was given', async () => {
    // Regression: the retry event used to close over the instance's
    // default model, so a per-call override (`params.model`) never showed
    // up in it even though the request itself used the override.
    const onEvent = vi.fn();
    const { client } = createMockClient([new Error('a'), jsonResponse({ ok: true })]);
    const llm = new VernLLM({
      client,
      model: 'default-model',
      maxRetries: 1,
      baseDelayMs: 0,
      onEvent,
    });

    await llm.call({ userContent: 'u', model: 'override-model' });

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'retry', model: 'override-model' }),
    );
  });

  it('swallows a throwing onEvent handler instead of failing the call', async () => {
    const onEvent = vi.fn(() => {
      throw new Error('onEvent boom');
    });
    const { client } = createMockClient([new Error('a'), jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 0, onEvent });

    await expect(llm.call({ userContent: 'u' })).resolves.toEqual({ ok: true });
    expect(onEvent).toHaveBeenCalled();
  });

  it('no onEvent configured means no behavioural change (call still succeeds after a retry)', async () => {
    const { client } = createMockClient([new Error('a'), jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 1, baseDelayMs: 0 });

    await expect(llm.call({ userContent: 'u' })).resolves.toEqual({ ok: true });
  });
});

describe('VernLLM, onEvent: circuit_state', () => {
  it('fires "circuit_state" when the breaker opens, with from/to and the failure count', async () => {
    const onEvent = vi.fn();
    const { client } = createMockClient([new Error('down')]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 2, cooldownMs: 10_000 },
      onEvent,
    });

    await llm.call({ userContent: 'u' }).catch(() => {});
    await llm.call({ userContent: 'u' }).catch(() => {});

    const circuitEvents = onEvent.mock.calls
      .map((c) => c[0] as VernLLMEvent)
      .filter((e) => e.kind === 'circuit_state');

    expect(circuitEvents).toHaveLength(1);
    expect(circuitEvents[0]).toMatchObject({
      kind: 'circuit_state',
      provider: 'primary',
      model: 'm',
      from: 'closed',
      to: 'open',
      consecutiveFailures: 2,
    });
  });

  it('reports the per-call `model` override of the call that actually triggered the transition', async () => {
    // Regression: the breaker used to always report the instance's
    // default model, ignoring which call's failure actually tripped it.
    const onEvent = vi.fn();
    const { client } = createMockClient([new Error('down')]);
    const llm = new VernLLM({
      client,
      model: 'default-model',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      onEvent,
    });

    await llm.call({ userContent: 'u', model: 'override-model' }).catch(() => {});

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'circuit_state', to: 'open', model: 'override-model' }),
    );
  });

  it('fires "circuit_state" again when the breaker closes after a successful trial', async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const { client } = createMockClient([new Error('down'), jsonResponse({ ok: true })]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 1000 },
      onEvent,
    });

    await llm.call({ userContent: 'u' }).catch(() => {});
    vi.advanceTimersByTime(1001);
    await llm.call({ userContent: 'u' });

    const transitions = onEvent.mock.calls
      .map((c) => c[0] as VernLLMEvent)
      .filter((e) => e.kind === 'circuit_state')
      .map((e) => (e.kind === 'circuit_state' ? `${e.from}->${e.to}` : ''));

    expect(transitions).toEqual(['closed->open', 'open->half-open', 'half-open->closed']);
    vi.useRealTimers();
  });

  it('never fires "circuit_state" for a no-op transition (e.g. failing while already open)', async () => {
    const onEvent = vi.fn();
    const { client } = createMockClient([new Error('down')]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      onEvent,
    });

    // First call opens the circuit.
    await llm.call({ userContent: 'u' }).catch(() => {});
    // Second call is short-circuited by assertClosed() and never calls
    // recordFailure(), so the breaker stays 'open' the whole time and no
    // second event should fire.
    await llm.call({ userContent: 'u' }).catch(() => {});

    const circuitEvents = onEvent.mock.calls
      .map((c) => c[0] as VernLLMEvent)
      .filter((e) => e.kind === 'circuit_state');
    expect(circuitEvents).toHaveLength(1);
  });

  it('swallows a throwing onEvent handler on a circuit transition instead of failing the call', async () => {
    const onEvent = vi.fn(() => {
      throw new Error('onEvent boom');
    });
    const { client } = createMockClient([new Error('down')]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      onEvent,
    });

    await expect(llm.call({ userContent: 'u' })).rejects.toMatchObject({ type: 'unknown' });
    expect(llm.getCircuitState()).toBe('open');
  });

  it('no circuitBreaker configured means no circuit_state events, ever', async () => {
    const onEvent = vi.fn();
    const { client } = createMockClient([new Error('down'), new Error('down')]);
    const llm = new VernLLM({ client, model: 'm', maxRetries: 0, onEvent });

    await llm.call({ userContent: 'u' }).catch(() => {});
    await llm.call({ userContent: 'u' }).catch(() => {});

    expect(
      onEvent.mock.calls.map((c) => c[0] as VernLLMEvent).some((e) => e.kind === 'circuit_state'),
    ).toBe(false);
  });
});

describe('VernLLM, TokenUsage.provider', () => {
  it('defaults to "primary" when no `name` option is given', async () => {
    const onUsage = vi.fn();
    const { client } = createMockClient([
      jsonResponse({ ok: true }, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ]);
    const llm = new VernLLM({ client, model: 'm', onUsage });

    await llm.call({ userContent: 'u' });

    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: 'primary' }));
  });

  it('reflects the configured `name` option', async () => {
    const onUsage = vi.fn();
    const { client } = createMockClient([
      jsonResponse({ ok: true }, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ]);
    const llm = new VernLLM({ client, model: 'm', name: 'anthropic', onUsage });

    await llm.call({ userContent: 'u' });

    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic' }));
  });
});
