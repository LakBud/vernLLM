import { describe, expect, it, vi } from 'vitest';

import {
  callContext,
  claimTrial,
  claimTrials,
  isOpen,
  learn,
  sleep,
  transitionReply,
  trip,
} from '../../breakerHelpers.js';

import type { CircuitBreakerAdapter, CircuitState } from 'vern-llm';

function fakeBreaker(overrides: Partial<CircuitBreakerAdapter> = {}): CircuitBreakerAdapter {
  return {
    assertClosed: () => {},
    recordSuccess: () => {},
    recordFailure: () => {},
    onStateChange: () => {},
    ...overrides,
  };
}

describe('sleep and callContext', () => {
  it('sleep resolves after roughly the delay', async () => {
    const started = Date.now();
    await sleep(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('every context is its own object with its own state bag', () => {
    const [a, b] = [callContext(), callContext()];

    expect(a).not.toBe(b);
    expect(a.state).not.toBe(b.state);
    expect(a.requestId).toBe('r');
  });
});

describe('isOpen', () => {
  it('is true when assertClosed rejects and false when it lets the call through', () => {
    const throwing = fakeBreaker({
      assertClosed: () => {
        throw new Error('open');
      },
    });

    expect(isOpen(throwing)).toBe(true);
    expect(isOpen(fakeBreaker())).toBe(false);
  });

  it('asks about the model it is given, defaulting to "m"', () => {
    const assertClosed = vi.fn();

    isOpen(fakeBreaker({ assertClosed }));
    isOpen(fakeBreaker({ assertClosed }), 'gpt');

    expect(assertClosed.mock.calls.map((call) => call[0])).toEqual(['m', 'gpt']);
  });
});

describe('trip and learn', () => {
  it('trip records a failure for the model and waits until the breaker reports open', async () => {
    let state: CircuitState = 'closed';
    const recordFailure = vi.fn(() => setTimeout(() => (state = 'open'), 30));

    await trip(fakeBreaker({ recordFailure, getState: () => state }), 'gpt');

    expect(recordFailure).toHaveBeenCalledWith('gpt');
    expect(state).toBe('open');
  });

  it('trip defaults to the model "m"', async () => {
    const recordFailure = vi.fn();

    await trip(fakeBreaker({ recordFailure, getState: () => 'open' }));

    expect(recordFailure).toHaveBeenCalledWith('m');
  });

  it('learn makes one call, then waits until the breaker has left its default closed', async () => {
    let state: CircuitState = 'closed';
    const assertClosed = vi.fn(() => void setTimeout(() => (state = 'half-open'), 30));

    await learn(fakeBreaker({ assertClosed, getState: () => state }));

    expect(assertClosed).toHaveBeenCalledTimes(1);
    expect(assertClosed).toHaveBeenCalledWith('m');
    expect(state).toBe('half-open');
  });
});

describe('claimTrials', () => {
  it('admits that many calls and returns a distinct context for each', async () => {
    const admitted: unknown[] = [];
    const breaker = fakeBreaker({ assertClosed: (_model, context) => void admitted.push(context) });

    const claimed = await claimTrials(breaker, 3);

    expect(claimed).toHaveLength(3);
    expect(new Set(claimed).size).toBe(3);
    expect(claimed).toEqual(admitted);
  });

  it('keeps polling while calls are rejected, and returns once enough get through', async () => {
    let rejections = 3;
    const breaker = fakeBreaker({
      assertClosed: () => {
        if (rejections-- > 0) throw new Error('no slot yet');
      },
    });

    await expect(claimTrials(breaker, 2, { intervalMs: 1 })).resolves.toHaveLength(2);
  });

  it('asks about the model it is given, defaulting to "m"', async () => {
    const assertClosed = vi.fn();

    await claimTrials(fakeBreaker({ assertClosed }), 1);
    await claimTrials(fakeBreaker({ assertClosed }), 1, { model: 'gpt' });

    expect(assertClosed.mock.calls.map((call) => call[0])).toEqual(['m', 'gpt']);
  });

  it('gives up with how many it got and what state the breaker was in', async () => {
    let admittedOnce = false;
    const breaker = fakeBreaker({
      assertClosed: () => {
        if (admittedOnce) throw new Error('no slot');
        admittedOnce = true;
      },
      getState: () => 'half-open',
    });

    await expect(claimTrials(breaker, 3, { timeoutMs: 60, intervalMs: 5 })).rejects.toThrow(
      'claimTrials: admitted 1 of 3 calls within 60ms (breaker state: half-open)',
    );
  });

  it('claimTrial returns just the one context', async () => {
    const context = await claimTrial(fakeBreaker());

    expect(context.requestId).toBe('r');
  });
});

describe('transitionReply', () => {
  it('defaults to a no-op reply in the shape the script returns', () => {
    expect(transitionReply('closed', 'closed')).toEqual([
      'closed',
      'closed',
      '5',
      '0',
      '0',
      '',
      '',
      '1000',
      '30000',
      '0',
      '0',
    ]);
  });

  it('a token makes it a reply that won a slot of that epoch', () => {
    const reply = transitionReply('open', 'half-open', { token: '7', slots: 2, grantAt: 900 });

    expect(reply.slice(3, 6)).toEqual(['1', '0', '7']);
    expect([reply[9], reply[10]]).toEqual(['900', '2']);
  });

  it('every field can be overridden', () => {
    expect(
      transitionReply('a', 'b', {
        failures: 1,
        openedAt: 2,
        now: 3,
        cooldown: 4,
        grantAt: 5,
        slots: 6,
      }),
    ).toEqual(['a', 'b', '1', '0', '2', '', '', '3', '4', '5', '6']);
  });
});
