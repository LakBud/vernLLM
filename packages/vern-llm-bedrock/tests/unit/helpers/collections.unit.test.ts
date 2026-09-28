import { describe, expect, it, vi } from 'vitest';

import { at, collect, fakeStream } from '../../helpers.js';

describe('fakeStream', () => {
  it('yields the events in order and then finishes', async () => {
    const seen: unknown[] = [];

    for await (const event of fakeStream([1, 'two', { three: 3 }])) seen.push(event);

    expect(seen).toEqual([1, 'two', { three: 3 }]);
  });

  it('finishes at once for no events', async () => {
    const iterator = fakeStream([])[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it('keeps reporting done after the last event', async () => {
    const iterator = fakeStream(['only'])[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: false, value: 'only' });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it('can be iterated again, each pass starting from the first event', async () => {
    const stream = fakeStream(['a', 'b']);

    expect(await collect(stream)).toEqual(['a', 'b']);
    expect(await collect(stream)).toEqual(['a', 'b']);
  });

  it('runs onReturn when the consumer stops early', async () => {
    const onReturn = vi.fn();

    for await (const event of fakeStream(['a', 'b', 'c'], onReturn)) {
      if (event === 'a') break;
    }

    expect(onReturn).toHaveBeenCalledOnce();
  });

  it('waits for an async onReturn before return() resolves', async () => {
    const order: string[] = [];
    const iterator = fakeStream(['a'], async () => {
      await Promise.resolve();
      order.push('cleanup');
    })[Symbol.asyncIterator]();

    await iterator.return?.();
    order.push('returned');

    expect(order).toEqual(['cleanup', 'returned']);
  });

  it('finishes cleanly on early return when no onReturn was given', async () => {
    const iterator = fakeStream(['a', 'b'])[Symbol.asyncIterator]();

    expect(await iterator.return?.()).toEqual({ done: true, value: undefined });
  });
});

describe('collect', () => {
  it('gathers every item of an async iterable into an array', async () => {
    expect(await collect(fakeStream([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it('gives an empty array for an empty iterable', async () => {
    expect(await collect(fakeStream([]))).toEqual([]);
  });

  it('propagates an error thrown by the iterable', async () => {
    async function* failing() {
      yield 1;
      throw new Error('stream broke');
    }

    await expect(collect(failing())).rejects.toThrow('stream broke');
  });
});

describe('at', () => {
  it('returns the element at the index', () => {
    expect(at(['a', 'b', 'c'], 1)).toBe('b');
  });

  it('returns falsy elements that are not undefined', () => {
    expect(at([0, '', false, null], 0)).toBe(0);
    expect(at([0, '', false, null], 3)).toBeNull();
  });

  it.each([
    { items: [] as string[], index: 0 },
    { items: ['a'], index: 5 },
    { items: ['a'], index: -1 },
  ])('throws naming the index when $index is out of range', ({ items, index }) => {
    expect(() => at(items, index)).toThrow(`Expected an element at index ${index}`);
  });

  it('throws for an element that is present but undefined', () => {
    expect(() => at([undefined], 0)).toThrow('Expected an element at index 0');
  });
});
