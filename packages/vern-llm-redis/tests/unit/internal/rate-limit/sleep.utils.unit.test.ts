import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  sleepOrAbort,
  waitForWakeOrPoll,
} from '../../../../src/internal/rate-limit/sleep.utils.js';
import { createWaiterRegistry } from '../../../../src/internal/rate-limit/waiterRegistry.utils.js';

describe('sleepOrAbort', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the given duration when never aborted', async () => {
    const promise = sleepOrAbort(1000, undefined);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects immediately, without waiting, when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(sleepOrAbort(1000, controller.signal)).rejects.toMatchObject({ type: 'aborted' });
  });

  it('rejects the moment the signal aborts mid-sleep, before the duration elapses', async () => {
    const controller = new AbortController();
    const promise = sleepOrAbort(1000, controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({ type: 'aborted' });

    await vi.advanceTimersByTimeAsync(100);
    controller.abort();

    await assertion;
  });

  it('resolves normally when signal is undefined throughout', async () => {
    const promise = sleepOrAbort(500, undefined);
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('waitForWakeOrPoll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves once the poll interval elapses when the registry never wakes it', async () => {
    const registry = createWaiterRegistry();
    const promise = waitForWakeOrPoll(registry, 'k', 500, undefined);

    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves as soon as the registry wakes the key, well before the poll interval', async () => {
    const registry = createWaiterRegistry();
    const promise = waitForWakeOrPoll(registry, 'k', 60_000, undefined);

    registry.wake('k');
    await expect(promise).resolves.toBeUndefined();
  });

  it('registers itself with the registry under the given key', () => {
    const registry = createWaiterRegistry();
    void waitForWakeOrPoll(registry, 'k', 60_000, undefined);

    expect(registry.has('k')).toBe(true);
  });

  it('removes itself from the registry once the poll interval fires naturally', async () => {
    const registry = createWaiterRegistry();
    const promise = waitForWakeOrPoll(registry, 'k', 500, undefined);

    await vi.advanceTimersByTimeAsync(500);
    await promise;

    expect(registry.has('k')).toBe(false);
  });

  it('rejects and removes itself from the registry when the signal aborts before either wake or timeout', async () => {
    const registry = createWaiterRegistry();
    const controller = new AbortController();
    const promise = waitForWakeOrPoll(registry, 'k', 60_000, controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({ type: 'aborted' });

    controller.abort();

    await assertion;
    expect(registry.has('k')).toBe(false);
  });

  it('does not reject once already woken, even if the signal aborts afterward', async () => {
    const registry = createWaiterRegistry();
    const controller = new AbortController();
    const promise = waitForWakeOrPoll(registry, 'k', 60_000, controller.signal);

    registry.wake('k');
    await expect(promise).resolves.toBeUndefined();

    // The abort listener was removed as part of resolving, so aborting
    // after the fact must have no effect on an already-settled promise.
    expect(() => controller.abort()).not.toThrow();
  });
});
