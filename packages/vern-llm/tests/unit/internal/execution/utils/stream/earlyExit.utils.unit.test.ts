import { describe, it, expect, vi } from 'vitest';

import { onEarlyExit } from '../../../../../../src/internal/execution/utils/stream/earlyExit.utils.js';

/** An iterable over `values` that records every `return()` and can fail on a given pull. */
function source(values: number[], options: { failAt?: number } = {}) {
  const returned = vi.fn();

  const iterable: AsyncIterable<number> = {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index === options.failAt) throw new Error('stream failed');
          return index < values.length
            ? { done: false, value: values[index++]! }
            : { done: true, value: undefined };
        },
        async return() {
          returned();
          return { done: true, value: undefined };
        },
      };
    },
  };

  return { iterable, returned };
}

describe('onEarlyExit', () => {
  it('passes every value through and does not fire when the reader reaches the end', async () => {
    const { iterable } = source([1, 2, 3]);
    const onExit = vi.fn();
    const seen: number[] = [];

    for await (const value of onEarlyExit(iterable, onExit)) seen.push(value);

    expect(seen).toEqual([1, 2, 3]);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('fires once on a break and still closes the inner iterator', async () => {
    const { iterable, returned } = source([1, 2, 3]);
    const onExit = vi.fn();

    for await (const _ of onEarlyExit(iterable, onExit)) break;

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(returned).toHaveBeenCalledTimes(1);
  });

  it('fires only once when return() is called again', async () => {
    const { iterable } = source([1, 2]);
    const onExit = vi.fn();
    const iterator = onEarlyExit(iterable, onExit)[Symbol.asyncIterator]();

    await iterator.next();
    await expect(iterator.return!()).resolves.toEqual({ done: true, value: undefined });
    await iterator.return!();

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('fires on return() before anything was read', async () => {
    const { iterable } = source([1]);
    const onExit = vi.fn();

    await onEarlyExit(iterable, onExit)[Symbol.asyncIterator]().return!();

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('does not fire when the stream itself fails, since there is nothing left to stop', async () => {
    const { iterable } = source([1, 2], { failAt: 1 });
    const onExit = vi.fn();

    await expect(
      (async () => {
        for await (const _ of onEarlyExit(iterable, onExit)) {
          // keep reading until the pull rejects
        }
      })(),
    ).rejects.toThrow('stream failed');

    expect(onExit).not.toHaveBeenCalled();
  });

  it('does not fire on a return() after the reader already reached the end', async () => {
    const { iterable } = source([1]);
    const onExit = vi.fn();
    const iterator = onEarlyExit(iterable, onExit)[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.next();
    await iterator.return!();

    expect(onExit).not.toHaveBeenCalled();
  });

  it('tracks each reader on its own', async () => {
    const { iterable } = source([1, 2]);
    const onExit = vi.fn();
    const wrapped = onEarlyExit(iterable, onExit);

    for await (const _ of wrapped) {
      // first reader reaches the end
    }
    for await (const _ of wrapped) break;

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('does not fire while another reader is still active, then fires when the last one leaves', async () => {
    const { iterable } = source([1, 2, 3]);
    const onExit = vi.fn();
    const wrapped = onEarlyExit(iterable, onExit);
    const a = wrapped[Symbol.asyncIterator]();
    const b = wrapped[Symbol.asyncIterator]();

    await a.next();
    await b.next();
    await a.return!();
    expect(onExit).not.toHaveBeenCalled();

    await b.return!();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('counts a reader that reached the end as gone, so the next early exit fires', async () => {
    const { iterable } = source([1]);
    const onExit = vi.fn();
    const wrapped = onEarlyExit(iterable, onExit);
    const a = wrapped[Symbol.asyncIterator]();
    const b = wrapped[Symbol.asyncIterator]();

    await b.next();
    await a.next();
    await a.next(); // the shared source is now exhausted for a
    await b.return!();

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('counts a reader whose pull rejected as gone, so the next early exit fires', async () => {
    const { iterable } = source([1, 2], { failAt: 1 });
    const onExit = vi.fn();
    const wrapped = onEarlyExit(iterable, onExit);
    const a = wrapped[Symbol.asyncIterator]();
    const b = wrapped[Symbol.asyncIterator]();

    await a.next();
    await b.next();
    await expect(b.next()).rejects.toThrow('stream failed');
    await a.return!();

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('does not fire when a reader that never pulled returns while another is active', async () => {
    const { iterable } = source([1, 2]);
    const onExit = vi.fn();
    const wrapped = onEarlyExit(iterable, onExit);
    const reading = wrapped[Symbol.asyncIterator]();

    await reading.next();
    await wrapped[Symbol.asyncIterator]().return!();

    expect(onExit).not.toHaveBeenCalled();
  });

  it('does not count a reader again when it pulls after reaching the end', async () => {
    const { iterable } = source([]);
    const onExit = vi.fn();
    const wrapped = onEarlyExit(iterable, onExit);
    const a = wrapped[Symbol.asyncIterator]();

    await a.next();
    await a.next();
    await wrapped[Symbol.asyncIterator]().return!();

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('works over an inner iterator that has no return()', async () => {
    const inner: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: 1 }) }),
    };
    const onExit = vi.fn();

    for await (const _ of onEarlyExit(inner, onExit)) break;

    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
