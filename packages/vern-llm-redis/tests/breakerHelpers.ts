import { vi } from 'vitest';

import { waitUntil } from './helpers.js';

import type { CircuitBreakerAdapter, CircuitBreakerCallContext } from 'vern-llm';

/**
 * `vi.waitFor` polling every millisecond instead of every 50. A test that only
 * waits for a fake Redis reply to land would otherwise pay a full 50ms for it,
 * and many of them do.
 */
export const waitFor = <T>(callback: () => T | Promise<T>, timeout = 1000): Promise<T> =>
  vi.waitFor(callback, { interval: 1, timeout });

/** Resolves after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A fresh call context. Each call gets its own state bag, the identity a trial slot is tracked by. */
export function callContext(): CircuitBreakerCallContext {
  return { requestId: 'r', state: {} as CircuitBreakerCallContext['state'] };
}

/**
 * Whether `assertClosed` rejects right now: the circuit is open, or
 * half-open with no slot for this process. Note it is a real call, so it
 * spends a half-open slot if this process holds one.
 */
export function isOpen(breaker: CircuitBreakerAdapter, model = 'm'): boolean {
  try {
    breaker.assertClosed(model);
    return false;
  } catch {
    return true;
  }
}

/** Trips a breaker built with `threshold: 1` and waits until the trip is confirmed locally. */
export async function trip(breaker: CircuitBreakerAdapter, model = 'm'): Promise<void> {
  breaker.recordFailure(model);
  await waitUntil(() => breaker.getState?.(model) === 'open');
}

/**
 * A process that has never touched a key treats it as closed (documented:
 * assertClosed is synchronous, Redis isn't). One call, whose background
 * check pulls Redis's real state into the local cache, teaches it.
 */
export async function learn(breaker: CircuitBreakerAdapter, model = 'm'): Promise<void> {
  breaker.assertClosed(model);
  await waitUntil(() => breaker.getState?.(model) !== 'closed');
}

/**
 * Polls `assertClosed` with a fresh context per attempt until `count`
 * calls have been admitted, and returns their contexts. Use it to take
 * half-open trial slots without hand rolling the loop.
 *
 * Gives up after `timeoutMs` with what it saw, so a run that fell short
 * says how many slots it got and what state the breaker was in, instead
 * of a bare "condition not met".
 */
export async function claimTrials(
  breaker: CircuitBreakerAdapter,
  count: number,
  {
    model = 'm',
    timeoutMs = 1500,
    intervalMs = 10,
  }: { model?: string; timeoutMs?: number; intervalMs?: number } = {},
): Promise<CircuitBreakerCallContext[]> {
  const claimed: CircuitBreakerCallContext[] = [];
  const deadline = Date.now() + timeoutMs;

  while (claimed.length < count && Date.now() < deadline) {
    const context = callContext();

    try {
      breaker.assertClosed(model, context);
      claimed.push(context);
    } catch {
      await sleep(intervalMs);
    }
  }

  if (claimed.length < count) {
    throw new Error(
      `claimTrials: admitted ${claimed.length} of ${count} calls within ${timeoutMs}ms (breaker state: ${breaker.getState?.(model)})`,
    );
  }

  return claimed;
}

/** `claimTrials` for a single slot. */
export async function claimTrial(
  breaker: CircuitBreakerAdapter,
  options?: Parameters<typeof claimTrials>[2],
): Promise<CircuitBreakerCallContext> {
  return (await claimTrials(breaker, 1, options))[0]!;
}

/**
 * TRANSITION_SCRIPT's reply as a fake Redis would return it: [from, to,
 * failures, wonProbe, openedAt, wonToken, breakdown, now, cooldown,
 * grantAt, slots], all strings. Pass `token` to make it a reply that won
 * a half-open slot of that epoch.
 */
export function transitionReply(
  from: string,
  to: string,
  fields: {
    failures?: number;
    token?: string;
    openedAt?: number;
    now?: number;
    cooldown?: number;
    grantAt?: number;
    slots?: number;
  } = {},
): string[] {
  return [
    from,
    to,
    String(fields.failures ?? 5),
    fields.token === undefined ? '0' : '1',
    String(fields.openedAt ?? 0),
    fields.token ?? '',
    '',
    String(fields.now ?? 1000),
    String(fields.cooldown ?? 30_000),
    String(fields.grantAt ?? 0),
    String(fields.slots ?? 0),
  ];
}
