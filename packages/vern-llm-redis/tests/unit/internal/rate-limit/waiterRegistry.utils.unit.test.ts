import { describe, expect, it, vi } from 'vitest';

import { createWaiterRegistry } from '../../../../src/internal/rate-limit/waiterRegistry.utils.js';

describe('createWaiterRegistry', () => {
  it('wake() is a no-op for a key with no registered waiters', () => {
    const registry = createWaiterRegistry();
    expect(() => registry.wake('never-registered')).not.toThrow();
  });

  it('wake() fires every waiter registered for that key', () => {
    const registry = createWaiterRegistry();
    const first = vi.fn();
    const second = vi.fn();

    registry.register('k', first);
    registry.register('k', second);
    registry.wake('k');

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('wake() never fires a waiter registered under a different key', () => {
    const registry = createWaiterRegistry();
    const waiter = vi.fn();

    registry.register('k1', waiter);
    registry.wake('k2');

    expect(waiter).not.toHaveBeenCalled();
  });

  it('has() reflects whether a key currently has any registered waiter', () => {
    const registry = createWaiterRegistry();
    expect(registry.has('k')).toBe(false);

    registry.register('k', vi.fn());
    expect(registry.has('k')).toBe(true);
  });

  it('a woken waiter is removed from the registry, not left registered', () => {
    // The bug this regression test guards: a waiter used to only be
    // removed from its key's set via a timeout or an abort, wake() fired
    // it but left the entry behind, an unbounded per-key leak over the
    // life of a process. wake() now removes each waiter as part of
    // firing it.
    const registry = createWaiterRegistry();
    registry.register('k', vi.fn());

    registry.wake('k');

    expect(registry.has('k')).toBe(false);
  });

  it('waking a key with several waiters removes every one of them, not just the first', () => {
    const registry = createWaiterRegistry();
    registry.register('k', vi.fn());
    registry.register('k', vi.fn());
    registry.register('k', vi.fn());

    registry.wake('k');

    expect(registry.has('k')).toBe(false);
  });

  it('the unregister function returned by register() removes only that one waiter', () => {
    const registry = createWaiterRegistry();
    const first = vi.fn();
    const second = vi.fn();

    const unregisterFirst = registry.register('k', first);
    registry.register('k', second);

    unregisterFirst();
    registry.wake('k');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('the unregister function is idempotent, a second call is a harmless no-op', () => {
    const registry = createWaiterRegistry();
    const unregister = registry.register('k', vi.fn());

    unregister();
    expect(() => unregister()).not.toThrow();
    expect(registry.has('k')).toBe(false);
  });

  it('unregistering the last waiter for a key removes the key entirely, not just the waiter', () => {
    const registry = createWaiterRegistry();
    const unregister = registry.register('k', vi.fn());

    unregister();

    expect(registry.has('k')).toBe(false);
  });

  it('unregistering one of several waiters leaves the key, and the others, registered', () => {
    const registry = createWaiterRegistry();
    const stays = vi.fn();

    const unregisterFirst = registry.register('k', vi.fn());
    registry.register('k', stays);

    unregisterFirst();

    expect(registry.has('k')).toBe(true);
    registry.wake('k');
    expect(stays).toHaveBeenCalledTimes(1);
  });

  it('unregistering a key that was never registered is a harmless no-op', () => {
    const registry = createWaiterRegistry();
    // A waiter that already got cleaned up via wake() calling its own
    // unregister function a second time, e.g. a stray abort listener
    // firing after the fact, must not throw.
    const unregister = registry.register('k', vi.fn());
    registry.wake('k');

    expect(() => unregister()).not.toThrow();
  });

  it('two different registries never see each other\u2019s waiters', () => {
    const a = createWaiterRegistry();
    const b = createWaiterRegistry();
    const waiter = vi.fn();

    a.register('k', waiter);
    b.wake('k');

    expect(waiter).not.toHaveBeenCalled();
  });
});
