import { afterEach, describe, expect, it, vi } from 'vitest';

import { VernLLM } from '../../../src/vernLLM.js';
import { createMockClient, jsonResponse } from '../../helpers.js';

import type { VernLLMMiddleware } from '../../../src/types/index.js';

// Tests switch to fake timers and spies themselves. Restoring here means a failed assertion
// can't leak them into the next test.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('VernLLM, circuit breaker on the call path', () => {
  it('records exactly one failure per failed call(), not one per attempt', async () => {
    const { client } = createMockClient([new Error('a'), new Error('b')]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 1, // 2 attempts per call()
      baseDelayMs: 0,
      circuitBreaker: { threshold: 3, cooldownMs: 1000 },
    });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});
    // Both attempts failed within a single call(), breaker should register
    // this as ONE consecutive failure, not two (regression test for a bug
    // where recordFailure() was invoked both in the catch block and again
    // after the loop).
    expect(llm.getCircuitState()).toBe('closed');
  });

  it('opens after enough failed call()s and blocks further calls with circuit_open', async () => {
    const { client, create } = createMockClient([new Error('down')]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 2, cooldownMs: 10_000 },
    });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});
    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});
    expect(llm.getCircuitState()).toBe('open');

    const callCountBefore = create.mock.calls.length;
    await expect(llm.call({ systemPrompt: 's', userContent: 'u' })).rejects.toMatchObject({
      type: 'circuit_open',
    });
    // The blocked call should not have reached the client at all.
    expect(create.mock.calls.length).toBe(callCountBefore);
  });

  it('does not reserve usage for a blocked call when the sole target is open, fails fast before reserving', async () => {
    const { client, create } = createMockClient([new Error('down')]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
    });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});
    expect(llm.getCircuitState()).toBe('open');

    const reserveUsage = vi.fn();
    const refundUsage = vi.fn();
    const callCountBefore = create.mock.calls.length;

    await expect(
      llm.call({ systemPrompt: 's', userContent: 'u', reserveUsage, refundUsage }),
    ).rejects.toMatchObject({ type: 'circuit_open' });

    expect(reserveUsage).not.toHaveBeenCalled();
    expect(refundUsage).not.toHaveBeenCalled();
    expect(create.mock.calls.length).toBe(callCountBefore);
  });

  it("a signal that aborts during a slow wrap, before assertBreakerClosed runs, doesn't leak the half-open trial slot", async () => {
    const { client } = createMockClient([new Error('down'), jsonResponse({ ok: true })]);

    let gate: Promise<void> = Promise.resolve();
    let releaseGate: (() => void) | undefined;
    const armGate = () => {
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    };

    const slowWrap: VernLLMMiddleware = {
      name: 'slow',
      wrap: async (_request, next) => {
        await gate;
        return next();
      },
    };

    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 1000 },
      middleware: [slowWrap],
    });

    // Trip the breaker open.
    await llm.call({ systemPrompt: 's', userContent: 'first' }).catch(() => {});
    expect(llm.getCircuitState()).toBe('open');

    // Wait past cooldown so the circuit is eligible for a half-open trial.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Start a trial call and abort it while `wrap` is still delaying, i.e.
    // before `assertBreakerClosed` (inside `coreOperation`) has run at all.
    armGate();
    const controller = new AbortController();
    const trialPromise = llm.call({
      systemPrompt: 's',
      userContent: 'trial',
      signal: controller.signal,
    });

    controller.abort();
    releaseGate?.();

    await expect(trialPromise).rejects.toMatchObject({ type: 'aborted' });

    // A leaked trial slot would reject this with `circuit_trial_in_flight`
    // even though nothing is actually still in flight.
    await expect(
      llm.call({ systemPrompt: 's', userContent: 'after' }),
    ).resolves.not.toBeUndefined();
  });

  it('closes again after a successful call', async () => {
    const { client } = createMockClient([new Error('down'), jsonResponse({ ok: true })]);
    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 5, cooldownMs: 1000 },
    });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});
    await llm.call({ systemPrompt: 's', userContent: 'u' });
    expect(llm.getCircuitState()).toBe('closed');
  });

  it('lets only one trial call reach the provider when several calls race right as cooldown ends', async () => {
    vi.useFakeTimers();

    let resolveTrial!: () => void;
    const trialGate = new Promise<void>((resolve) => {
      resolveTrial = resolve;
    });

    const { client, create } = createMockClient([
      new Error('down'), // opens the circuit
      async () => {
        // The trial call hangs until we release it, so concurrent callers
        // firing while it's outstanding have a real window to race against it
        await trialGate;
        return jsonResponse({ ok: true });
      },
    ]);

    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 1000 },
    });

    await llm.call({ systemPrompt: 's', userContent: 'u' }).catch(() => {});
    expect(llm.getCircuitState()).toBe('open');

    vi.advanceTimersByTime(1001); // cooldown elapses

    // Fire several concurrent calls at once, right as the circuit becomes eligible for a trial
    const trialPromise = llm.call({ systemPrompt: 's', userContent: 'u' });
    // Give the first call a chance to become the trial before firing the rest
    await Promise.resolve();
    const rejectedPromises = [
      llm.call({ systemPrompt: 's', userContent: 'u' }),
      llm.call({ systemPrompt: 's', userContent: 'u' }),
    ];

    // The two concurrent callers should be rejected immediately, without
    // waiting on the outstanding trial
    const rejectedResults = await Promise.allSettled(rejectedPromises);
    expect(rejectedResults.every((r) => r.status === 'rejected')).toBe(true);
    for (const r of rejectedResults) {
      if (r.status === 'rejected') {
        expect(r.reason).toMatchObject({ type: 'circuit_open' });
      }
    }

    // Only the trial call should have reached the provider (1 open-circuit call + 1 trial call)
    expect(create.mock.calls.length).toBe(2);

    resolveTrial();
    await expect(trialPromise).resolves.toEqual({ ok: true });
    expect(llm.getCircuitState()).toBe('closed');
  });

  it('does not open the breaker on a parse failure', async () => {
    const { client } = createMockClient([{ choices: [{ message: { content: '{invalid json' } }] }]);

    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    await expect(
      llm.call({
        systemPrompt: 's',
        userContent: 'u',
      }),
    ).rejects.toMatchObject({
      type: 'parse',
    });

    expect(llm.getCircuitState()).toBe('closed');
  });

  it('does not open the breaker on a schema-validation failure', async () => {
    const { client } = createMockClient([jsonResponse({ wrong: 'shape' })]);

    const schema = {
      safeParse(
        value: unknown,
      ):
        | { success: true; data: object & { expected: unknown } }
        | { success: false; error: unknown } {
        if (typeof value === 'object' && value !== null && 'expected' in value) {
          return {
            success: true,
            data: value as object & { expected: unknown },
          };
        }

        return {
          success: false,
          error: { message: 'missing expected field' },
        };
      },
    };

    const llm = new VernLLM({
      client,
      model: 'm',
      maxRetries: 0,
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
    });

    await expect(
      llm.call({
        systemPrompt: 's',
        userContent: 'u',
        schema,
      }),
    ).rejects.toMatchObject({
      type: 'validation',
    });

    expect(llm.getCircuitState()).toBe('closed');
  });
});
