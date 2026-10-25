import { isLLMError } from 'vern-llm';
import { describe, expect, it, vi } from 'vitest';

import { keywords, type Check, type Detector, type GuardResult } from '../../src/index.js';
import { createStreamClient, harness, textDeltas } from '../helpers.js';

const call = { userContent: 'a risky prompt', jsonMode: false as const };
const code = (error: unknown) => (isLLMError(error) ? error.code : undefined);

function resultOf(events: { name: string; data: unknown }[]): GuardResult {
  const results = events.filter((event) => event.name === 'guard.result');
  expect(results).toHaveLength(1);
  return results[0]!.data as GuardResult;
}

/** A parallel check that answers after `ms`, with a finding when `hit` says so. */
function slowCheck(ms: number, hit: boolean, extra: Partial<Check> = {}) {
  const detect = vi.fn<Detector>(async (segments, signal) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return hit && !signal.aborted ? [{ segment: 0 }] : [];
  });
  const check: Check = { id: 'jailbreak', detect, action: 'block', parallel: true, ...extra };
  return { check, detect };
}

describe('a parallel check', () => {
  it('starts with the call, not before it', async () => {
    let providerCalled = () => {};
    const called = new Promise<void>((resolve) => {
      providerCalled = resolve;
    });
    // It can only finish once the provider has been called, which a check run first never would.
    const detect: Detector = async () => {
      await called;
      return [];
    };
    const { llm, events } = harness(
      { checks: [{ id: 'jailbreak', detect, action: 'block', parallel: true, timeoutMs: 1000 }] },
      {},
      {
        primary: () => {
          providerCalled();
          return 'fine';
        },
      },
    );

    await expect(llm.call(call)).resolves.toBe('fine');

    expect(resultOf(events)).toMatchObject({
      outcome: 'passed',
      input: { checks: { jailbreak: { found: 0 } } },
    });
  });

  it('runs once, and not again in a later attempt', async () => {
    const { check, detect } = slowCheck(1, false);
    const { llm } = harness({ checks: [check] });

    await llm.call(call);

    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('holds a plain answer, then fails the call when it blocks', async () => {
    const { check } = slowCheck(20, true);
    const { llm, primary, events } = harness({ checks: [check] });

    const error = await llm.call(call).catch((e: unknown) => e);

    expect(code(error)).toBe('content_blocked');
    // The answer was already generated and billed; that is the cost of the latency win.
    expect(primary.calls).toHaveLength(1);
    expect(resultOf(events)).toMatchObject({
      outcome: 'blocked',
      input: { checks: { jailbreak: { found: 1 } } },
    });
  });

  it('cancels a stream when it blocks, so no text reaches the caller', async () => {
    const { check } = slowCheck(20, true);
    // Far longer than the check takes, so the stream is still running when it answers.
    const sizes = Array.from({ length: 150 }, () => 4);
    const { client, state } = createStreamClient(textDeltas('word '.repeat(300), ...sizes));
    const { llm } = harness({ checks: [check] }, { client });

    const error = await llm
      .call({ ...call, stream: true as const } as never)
      .catch((e: unknown) => e);

    expect(code(error)).toBe('content_blocked');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.finished).toBe(false);
  });

  it('is stopped when the call fails before it is joined', async () => {
    let seen: AbortSignal | undefined;
    const detect: Detector = async (_segments, signal) => {
      seen = signal;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return [];
    };
    const { llm } = harness(
      { checks: [{ id: 'jailbreak', detect, action: 'block', parallel: true }] },
      {},
      {
        primary: () => Object.assign(new Error('bad request'), { status: 400 }),
        b: () => new Error('x'),
      },
    );

    await llm.call(call).catch(() => {});

    expect(seen?.aborted).toBe(true);
  });

  it('blocks before the provider call when it answers at once', async () => {
    const instant: Detector = () => [{ segment: 0 }];
    const { llm, primary } = harness({
      checks: [{ id: 'j', detect: instant, action: 'block', parallel: true }],
    });

    const error = await llm.call(call).catch((e: unknown) => e);

    expect(code(error)).toBe('content_blocked');
    expect(primary.calls).toHaveLength(0);
  });

  it('follows onError when it breaks', async () => {
    const broken: Detector = () => {
      throw new Error('boom');
    };
    const closed = harness({
      checks: [{ id: 'j', detect: broken, action: 'block', parallel: true }],
    });
    const open = harness({
      checks: [{ id: 'j', detect: broken, action: 'block', parallel: true, onError: 'open' }],
    });

    const error = await closed.llm.call(call).catch((e: unknown) => e);

    expect(code(error)).toBe('content_blocked');
    await expect(open.llm.call(call)).resolves.toBe('primary');
    expect(resultOf(open.events).input.errors).toEqual([{ check: 'j', name: 'Error' }]);
  });

  it('in audit mode reports what it would have done, and lets the call through', async () => {
    const { check } = slowCheck(1, true, { mode: 'audit' });
    const { llm, events } = harness({ checks: [check] });

    await expect(llm.call(call)).resolves.toBe('primary');

    expect(resultOf(events)).toMatchObject({
      outcome: 'passed',
      input: { audit: { jailbreak: 'block' } },
    });
  });

  it('is not part of the checks that run first, so policy never waits for it', async () => {
    const { check } = slowCheck(50, false);
    const quick: Check = { id: 'quick', detect: keywords(['risky']) };
    const { llm, labels } = harness({ checks: [quick, check] });

    await llm.call(call);

    expect(labels).toEqual([['quick']]);
  });
});
