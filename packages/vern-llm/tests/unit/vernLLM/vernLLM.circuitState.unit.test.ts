import { afterEach, describe, expect, it, vi } from 'vitest';

import { FallbackExhaustedError } from '../../../src/types/fallback.js';
import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, jsonResponse } from '../../helpers.js';

// Tests switch to fake timers and spies themselves. Restoring here means a failed assertion
// can't leak them into the next test.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('VernLLM, circuit state and manual control', () => {
  it('is undefined by default (opt-in)', () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });
    expect(llm.getCircuitState()).toBeUndefined();
  });

  it('returns circuit state for every target in the fallback chain', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      },
    });

    expect(llm.getCircuitStates()).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: false, state: 'closed' },
      { provider: 'fallback', index: 1, isFallback: true, isolateByModel: false, state: 'closed' },
    ]);
  });

  it('reports fallback circuit state independently from the primary', async () => {
    const { client: primaryClient } = createMockClient([new Error('primary down')]);
    const { client: fallbackClient } = createMockClient([new Error('fallback down')]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      },
    });

    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).rejects.toBeInstanceOf(
      FallbackExhaustedError,
    );

    expect(llm.getCircuitStates()).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: false, state: 'open' },
      { provider: 'fallback', index: 1, isFallback: true, isolateByModel: false, state: 'open' },
    ]);
  });

  it('returns undefined state for targets without a circuit breaker', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        // No circuit breaker.
      },
    });

    expect(llm.getCircuitStates()).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: false, state: 'closed' },
      { provider: 'fallback', index: 1, isFallback: true, isolateByModel: false, state: undefined },
    ]);
  });

  it("isolateByModel on getCircuitStates entries reflects each target's own breaker config", () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'gpt-4o',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true },
      fallback: {
        client: fallbackClient,
        model: 'claude-sonnet',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 }, // isolateByModel off
      },
    });

    expect(llm.getCircuitStates()).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: true, state: 'closed' },
      { provider: 'fallback', index: 1, isFallback: true, isolateByModel: false, state: 'closed' },
    ]);
  });

  it('getCircuitState() delegates to getCircuitStates() and defaults to the primary target', () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({
      client,
      model: 'm',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    expect(llm.getCircuitState()).toBe('closed');
    expect(llm.getCircuitState({})).toBe('closed');
  });

  it('getCircuitState({ index }) reaches a fallback target', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([new Error('fallback down')]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      circuitBreaker: { threshold: 5, cooldownMs: 10_000 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        maxRetries: 0,
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      },
    });

    expect(llm.getCircuitState({ index: 1 })).toBe('closed');
  });

  it('getCircuitState({ index }) scopes model to the resolved target only', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'gpt-4o',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true },
      fallback: {
        client: fallbackClient,
        model: 'claude-sonnet',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true },
      },
    });

    llm.openCircuit({ index: 0, model: 'gpt-4o' });

    expect(llm.getCircuitState({ index: 0, model: 'gpt-4o' })).toBe('open');
    expect(llm.getCircuitState({ index: 0, model: 'gpt-4o-mini' })).toBe('closed');
    expect(llm.getCircuitState({ index: 1, model: 'gpt-4o' })).toBe('closed');
  });

  it('getCircuitState warns (but still returns a value) when model is passed but the target has no isolateByModel', () => {
    const { client } = createMockClient([]);
    const warn = vi.fn();
    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 }, // isolateByModel off
      logger: { debug: vi.fn(), warn, error: vi.fn() },
    });

    expect(llm.getCircuitState({ model: 'gpt-4o' })).toBe('closed'); // shared bucket, not thrown
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('getCircuitState');
    expect(warn.mock.calls[0]![0]).toContain("model: 'gpt-4o'");

    // Bare, model-less calls on the same target don't warn at all.
    warn.mockClear();
    expect(llm.getCircuitState()).toBe('closed');
    expect(warn).not.toHaveBeenCalled();
  });

  it('openCircuit/closeCircuit warn (but still act on the shared bucket) for an unsupported model', () => {
    const { client } = createMockClient([]);
    const warn = vi.fn();
    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 }, // isolateByModel off
      logger: { debug: vi.fn(), warn, error: vi.fn() },
    });

    expect(() => llm.openCircuit({ model: 'gpt-4o' })).not.toThrow();
    expect(llm.getCircuitState()).toBe('open'); // shared bucket, not a no-op
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('openCircuit');

    warn.mockClear();
    expect(() => llm.closeCircuit({ model: 'gpt-4o' })).not.toThrow();
    expect(llm.getCircuitState()).toBe('closed');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('closeCircuit');
  });

  it('getCircuitState warns when model is passed but the target has no breaker at all', () => {
    const { client } = createMockClient([]);
    const warn = vi.fn();
    const llm = new VernLLM({
      client,
      model: 'm',
      logger: { debug: vi.fn(), warn, error: vi.fn() },
    }); // no circuitBreaker option

    expect(llm.getCircuitState({ model: 'gpt-4o' })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('the model-unsupported warning only fires for the target `index` actually resolves to', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);
    const warn = vi.fn();

    const llm = new VernLLM({
      client: primaryClient,
      model: 'gpt-4o',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true }, // isolates
      fallback: {
        client: fallbackClient,
        model: 'claude-sonnet',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 }, // does not isolate
      },
      logger: { debug: vi.fn(), warn, error: vi.fn() },
    });

    // Primary isolates: model is fine there, no warning.
    llm.getCircuitState({ index: 0, model: 'gpt-4o' });
    expect(warn).not.toHaveBeenCalled();

    // Fallback doesn't isolate: same-shaped call now warns, since it's
    // being asked of a different target with a different config.
    llm.getCircuitState({ index: 1, model: 'claude-sonnet' });
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();

    // Same split holds for openCircuit/closeCircuit, not just reads.
    llm.openCircuit({ index: 0, model: 'gpt-4o' });
    expect(warn).not.toHaveBeenCalled();

    llm.openCircuit({ index: 1, model: 'claude-sonnet' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('index is validated before model: an out-of-range index still throws RangeError even with an unsupported model', () => {
    const { client } = createMockClient([]);
    const warn = vi.fn();
    const llm = new VernLLM({
      client,
      model: 'm',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 }, // isolateByModel off too
      logger: { debug: vi.fn(), warn, error: vi.fn() },
    });

    // Both `index` and `model` are "wrong" here; index should be reported
    // first, and the model check should never even run.
    expect(() => llm.getCircuitState({ index: 9, model: 'gpt-4o' })).toThrow(RangeError);
    expect(() => llm.openCircuit({ index: 9, model: 'gpt-4o' })).toThrow(RangeError);

    expect(() => llm.closeCircuit({ index: 9, model: 'gpt-4o' })).toThrow(RangeError);
  });

  it("getCircuitState/openCircuit/closeCircuit default an omitted model to the target's configured model, on the primary", () => {
    const { client } = createMockClient([]);

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true },
    });

    llm.openCircuit(); // no model given
    // The state must show up under the executor's configured model, the
    // same bucket real call failures would use, not an unlabeled bucket.
    expect(llm.getCircuitState({ model: 'gpt-4o' })).toBe('open');
    expect(llm.getCircuitState()).toBe('open');

    llm.closeCircuit();
    expect(llm.getCircuitState({ model: 'gpt-4o' })).toBe('closed');
  });

  it("getCircuitState/openCircuit/closeCircuit default an omitted model to the target's configured model, on a fallback", () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'gpt-4o',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true },
      fallback: {
        client: fallbackClient,
        model: 'claude-sonnet',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true },
      },
    });

    llm.openCircuit({ index: 1 }); // no model given

    expect(llm.getCircuitState({ index: 1, model: 'claude-sonnet' })).toBe('open');
    expect(llm.getCircuitState({ index: 1 })).toBe('open');
    // Primary is untouched.
    expect(llm.getCircuitState({ index: 0 })).toBe('closed');

    expect(llm.getCircuitStates()).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: true, state: 'closed' },
      {
        provider: 'fallback[0]',
        index: 1,
        isFallback: true,
        isolateByModel: true,
        state: 'open',
      },
    ]);
  });

  it('getCircuitStates() stays permissive: model is safely ignored on non-isolating targets, no throw', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'gpt-4o',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000, isolateByModel: true },
      fallback: {
        client: fallbackClient,
        model: 'claude-sonnet',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 }, // does not isolate
      },
    });

    // Sweeping `model` across a mixed chain is exactly what getCircuitStates
    // is for. It must never throw just because one target ignores it.
    expect(() => llm.getCircuitStates('gpt-4o')).not.toThrow();
    expect(llm.getCircuitStates('gpt-4o')).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: true, state: 'closed' },
      { provider: 'fallback', index: 1, isFallback: true, isolateByModel: false, state: 'closed' },
    ]);
  });

  it('getCircuitState throws RangeError for an out-of-range index, distinct from a real target with no breaker', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        // No circuit breaker on the fallback -> a real target, just untracked.
      },
    });

    // Real target, no breaker: a legitimate `undefined`, not an error.
    expect(llm.getCircuitState({ index: 1 })).toBeUndefined();

    // No target at all at this index: distinguishable via a thrown error.
    expect(() => llm.getCircuitState({ index: 2 })).toThrow(RangeError);
    expect(() => llm.getCircuitState({ index: -1 })).toThrow(RangeError);
  });

  it('openCircuit()/closeCircuit() default to the primary target', () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({
      client,
      model: 'm',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    llm.openCircuit();
    expect(llm.getCircuitState()).toBe('open');

    llm.closeCircuit();
    expect(llm.getCircuitState()).toBe('closed');
  });

  it('openCircuit({ index })/closeCircuit({ index }) reach a fallback target', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      },
    });

    llm.openCircuit({ index: 1 });
    expect(llm.getCircuitStates()).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: false, state: 'closed' },
      { provider: 'fallback', index: 1, isFallback: true, isolateByModel: false, state: 'open' },
    ]);

    llm.closeCircuit({ index: 1 });
    expect(llm.getCircuitStates()).toEqual([
      { provider: 'primary', index: 0, isFallback: false, isolateByModel: false, state: 'closed' },
      { provider: 'fallback', index: 1, isFallback: true, isolateByModel: false, state: 'closed' },
    ]);
  });

  it('openCircuit/closeCircuit throw RangeError for an out-of-range index, same as getCircuitState', () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({
      client,
      model: 'm',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    expect(() => llm.openCircuit({ index: 5 })).toThrow(RangeError);
    expect(() => llm.closeCircuit({ index: 5 })).toThrow(RangeError);
    // Confirm it's a no-op, not a partial mutation before the throw.
    expect(llm.getCircuitState()).toBe('closed');
  });

  it('openCircuit/closeCircuit throw RangeError for a negative index', () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({
      client,
      model: 'm',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    expect(() => llm.openCircuit({ index: -1 })).toThrow(RangeError);
    expect(() => llm.closeCircuit({ index: -1 })).toThrow(RangeError);
    expect(llm.getCircuitState()).toBe('closed');
  });

  it('RangeError message names the failing method and reports the actual chain size', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      },
    });

    // Chain has 2 targets (primary + one fallback): index 2 is the first invalid one.
    expect(() => llm.getCircuitState({ index: 2 })).toThrow(/no target at index 2.*2 targets/);
    expect(() => llm.openCircuit({ index: 2 })).toThrow(/openCircuit.*no target at index 2/);
    expect(() => llm.closeCircuit({ index: 2 })).toThrow(/closeCircuit.*no target at index 2/);
  });

  it('RangeError message uses singular "target" for a chain with no fallback configured', () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({ client, model: 'm' }); // no fallback: chain has exactly 1 target

    expect(() => llm.getCircuitState({ index: 1 })).toThrow(/1 target\)/);
    expect(() => llm.getCircuitState({ index: 1 })).not.toThrow(/1 targets\)/);
  });

  it('an out-of-range index on one call does not affect a valid index on the next', () => {
    const { client: primaryClient } = createMockClient([]);
    const { client: fallbackClient } = createMockClient([]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      name: 'primary',
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      },
    });

    expect(() => llm.openCircuit({ index: 9 })).toThrow(RangeError);
    // The library's own internal state (executors array, etc.) is untouched
    // by a rejected call. A subsequent valid call still works normally.
    llm.openCircuit({ index: 1 });
    expect(llm.getCircuitState({ index: 1 })).toBe('open');
  });

  it('openCircuit/closeCircuit are no-ops (not throws) when no circuit breaker is configured', () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({ client, model: 'm' }); // no circuitBreaker option

    expect(() => llm.openCircuit()).not.toThrow();
    expect(() => llm.closeCircuit()).not.toThrow();
    expect(llm.getCircuitState()).toBeUndefined();
  });

  it('getFailureBreakdown is undefined by default (opt-in), same as getCircuitState', () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'm' });
    expect(llm.getFailureBreakdown()).toBeUndefined();
  });

  it('getFailureBreakdown reflects real call failures on the primary target', async () => {
    const { client } = createMockClient([new Error('down'), new Error('down')]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 5, cooldownMs: 10_000 },
    });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});
    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});

    const breakdown = llm.getFailureBreakdown();
    expect(breakdown).toBeDefined();
    const total = Object.values(breakdown ?? {}).reduce((a, b) => a + (b ?? 0), 0);
    expect(total).toBe(2);
  });

  it('getFailureBreakdown reads a fallback target by index, independent of the primary', async () => {
    const { client: primaryClient } = createMockClient([new Error('down')]);
    const { client: fallbackClient } = createMockClient([jsonResponse({ ok: true })]);

    const llm = new VernLLM({
      client: primaryClient,
      model: 'primary-model',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      fallback: {
        client: fallbackClient,
        model: 'fallback-model',
        name: 'fallback',
        circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      },
    });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});

    const primaryBreakdown = llm.getFailureBreakdown({ index: 0 });
    const fallbackBreakdown = llm.getFailureBreakdown({ index: 1 });
    expect(Object.keys(primaryBreakdown ?? {}).length).toBeGreaterThan(0);
    expect(fallbackBreakdown).toEqual({});
  });

  it('getFailureBreakdown throws RangeError for an out-of-range index', () => {
    const { client } = createMockClient([]);
    const llm = new VernLLM({ client, model: 'm', circuitBreaker: { threshold: 5 } });

    expect(() => llm.getFailureBreakdown({ index: 9 })).toThrow(RangeError);
  });
});
