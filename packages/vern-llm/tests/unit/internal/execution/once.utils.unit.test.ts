import { describe, expect, it, vi } from 'vitest';

import { createOnceAsync } from '../../../../src/internal/execution/utils/once.utils.js';

describe('createOnceAsync, call', () => {
  it('calls the wrapped function and resolves with its value', async () => {
    const fn = vi.fn().mockResolvedValue('result');
    const onceAsync = createOnceAsync(fn);

    await expect(onceAsync.call()).resolves.toBe('result');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('dispatches the wrapped function only once across repeated calls', async () => {
    const fn = vi.fn().mockResolvedValue('result');
    const onceAsync = createOnceAsync(fn);

    await onceAsync.call();
    await onceAsync.call();
    await onceAsync.call();

    expect(fn).toHaveBeenCalledOnce();
  });

  it('returns the same promise instance for repeated calls', () => {
    const onceAsync = createOnceAsync(() => Promise.resolve('result'));

    const first = onceAsync.call();
    const second = onceAsync.call();

    expect(second).toBe(first);
  });

  it('sees the first call already in flight for a second call issued before any await', async () => {
    const fn = vi.fn().mockResolvedValue('result');
    const onceAsync = createOnceAsync(fn);

    // No await between these two calls, unlike calling call() and
    // awaiting it before calling again.
    const [a, b] = [onceAsync.call(), onceAsync.call()];

    await Promise.all([a, b]);

    expect(fn).toHaveBeenCalledOnce();
  });

  it('rejects every caller with the same error when the wrapped function rejects', async () => {
    const onceAsync = createOnceAsync(() => Promise.reject(new Error('boom')));

    const first = onceAsync.call();
    const second = onceAsync.call();

    await expect(first).rejects.toThrow('boom');
    await expect(second).rejects.toThrow('boom');
  });

  it('does not surface an unhandled rejection when the caller discards the promise', async () => {
    const onceAsync = createOnceAsync(() => Promise.reject(new Error('discarded')));

    // Deliberately not awaited or otherwise observed, mirroring a
    // middleware that calls next() and then short-circuits without
    // awaiting what it returned.
    onceAsync.call();

    await new Promise((resolve) => setTimeout(resolve, 10));
    // No assertion beyond this test itself not failing via an
    // unhandled-rejection warning; vitest fails the run on those.
  });
});

describe('createOnceAsync, wasCalled', () => {
  it('is false before call() has ever been invoked', () => {
    const onceAsync = createOnceAsync(() => Promise.resolve('result'));

    expect(onceAsync.wasCalled()).toBe(false);
  });

  it('is true as soon as call() is invoked, synchronously, before it settles', () => {
    const onceAsync = createOnceAsync(() => new Promise<string>(() => {}));

    onceAsync.call();

    expect(onceAsync.wasCalled()).toBe(true);
  });
});

describe('createOnceAsync, resolvedValue', () => {
  it('is undefined before call() has resolved', () => {
    const onceAsync = createOnceAsync(() => new Promise<string>(() => {}));

    onceAsync.call();

    expect(onceAsync.resolvedValue()).toBeUndefined();
  });

  it('is the resolved value once call() has settled', async () => {
    const onceAsync = createOnceAsync(() => Promise.resolve('result'));

    await onceAsync.call();

    expect(onceAsync.resolvedValue()).toBe('result');
  });

  it('stays undefined when call() rejects instead of resolving', async () => {
    const onceAsync = createOnceAsync(() => Promise.reject(new Error('boom')));

    await onceAsync.call().catch(() => {});

    expect(onceAsync.resolvedValue()).toBeUndefined();
  });
});
