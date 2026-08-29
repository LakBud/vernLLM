import { describe, expect, it } from 'vitest';

import { createInFlightRegistry } from '../../../../../src/internal/cache/utils/inFlightRegistry.utils.js';

describe('createInFlightRegistry, get', () => {
  it('returns undefined for a key nothing was ever tracked under', () => {
    const registry = createInFlightRegistry<string>();

    expect(registry.get('missing')).toBeUndefined();
  });

  it('returns the tracked promise for a key with something in flight', () => {
    const registry = createInFlightRegistry<string>();
    const promise = new Promise<string>(() => {});

    registry.track('key', promise);

    expect(registry.get('key')).toBe(promise);
  });
});

describe('createInFlightRegistry, track', () => {
  it('returns the given promise unchanged', () => {
    const registry = createInFlightRegistry<string>();
    const promise = Promise.resolve('value');

    expect(registry.track('key', promise)).toBe(promise);
  });

  it('registers the promise synchronously, visible to get() immediately', () => {
    const registry = createInFlightRegistry<string>();
    const promise = new Promise<string>(() => {});

    registry.track('key', promise);

    // No await here on purpose: registration must be synchronous.
    expect(registry.get('key')).toBe(promise);
  });

  it('removes the entry once the tracked promise resolves', async () => {
    const registry = createInFlightRegistry<string>();

    await registry.track('key', Promise.resolve('value'));
    // The cleanup `.finally()` is attached to a separate promise chain
    // from the one `track()` returns, so it settles one microtask later.
    await Promise.resolve();

    expect(registry.get('key')).toBeUndefined();
  });

  it('removes the entry once the tracked promise rejects', async () => {
    const registry = createInFlightRegistry<string>();

    await registry.track('key', Promise.reject(new Error('boom'))).catch(() => {});

    expect(registry.get('key')).toBeUndefined();
  });

  it('does not surface an unhandled rejection when the tracked promise rejects and nobody observes it', async () => {
    const registry = createInFlightRegistry<string>();

    // Deliberately not awaited or caught by the test itself, mirroring a
    // caller that tracks a promise and moves on without handling it
    // directly (settlement is observed elsewhere, e.g. via get()).
    registry.track('key', Promise.reject(new Error('boom')));

    await new Promise((resolve) => setTimeout(resolve, 10));
    // No assertion beyond this test itself not failing via an
    // unhandled-rejection warning; vitest fails the run on those.
  });

  it('tracks independent keys independently', () => {
    const registry = createInFlightRegistry<string>();
    const a = new Promise<string>(() => {});
    const b = new Promise<string>(() => {});

    registry.track('a', a);
    registry.track('b', b);

    expect(registry.get('a')).toBe(a);
    expect(registry.get('b')).toBe(b);
  });

  it('replacing a key with a new promise makes get() return the new one', () => {
    const registry = createInFlightRegistry<string>();
    const first = new Promise<string>(() => {});
    const second = new Promise<string>(() => {});

    registry.track('key', first);
    registry.track('key', second);

    expect(registry.get('key')).toBe(second);
  });
});
