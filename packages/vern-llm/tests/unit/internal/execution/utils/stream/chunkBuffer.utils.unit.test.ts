import { describe, expect, it, vi } from 'vitest';

import { createBackpressureChannel } from '../../../../../../src/internal/execution/utils/stream/chunkBuffer.utils.js';

function testLogger() {
  return { warn: vi.fn() };
}

async function drain<T>(iterable: AsyncIterable<T>, count: number): Promise<T[]> {
  const iterator = iterable[Symbol.asyncIterator]();
  const values: T[] = [];

  for (let i = 0; i < count; i++) {
    const result = await iterator.next();
    if (result.done) break;
    values.push(result.value);
  }

  return values;
}

describe('createBackpressureChannel, push/pull order', () => {
  it('delivers pushed values to a waiting pull in the order they were pushed', async () => {
    const channel = createBackpressureChannel<string>({
      capacity: 10,
      logger: testLogger(),
      label: 'item',
    });
    const iterator = channel.iterable[Symbol.asyncIterator]();

    const first = iterator.next();
    const second = iterator.next();

    channel.push('a');
    channel.push('b');

    await expect(first).resolves.toEqual({ done: false, value: 'a' });
    await expect(second).resolves.toEqual({ done: false, value: 'b' });
  });

  it('buffers values pushed before anyone pulls, and hands them out in order', async () => {
    const channel = createBackpressureChannel<number>({
      capacity: 10,
      logger: testLogger(),
      label: 'item',
    });

    channel.push(1);
    channel.push(2);
    channel.push(3);

    const values = await drain(channel.iterable, 3);

    expect(values).toEqual([1, 2, 3]);
  });

  it('resolves done:true once finish is called and the buffer is drained', async () => {
    const channel = createBackpressureChannel<number>({
      capacity: 10,
      logger: testLogger(),
      label: 'item',
    });
    const iterator = channel.iterable[Symbol.asyncIterator]();

    channel.push(1);
    channel.finish();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('resolves a pending pull with done:true when finish is called with nothing buffered', async () => {
    const channel = createBackpressureChannel<number>({
      capacity: 10,
      logger: testLogger(),
      label: 'item',
    });
    const iterator = channel.iterable[Symbol.asyncIterator]();

    const pending = iterator.next();
    channel.finish();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });
});

describe('createBackpressureChannel, eviction', () => {
  it('does not evict while the buffer is at or under capacity', async () => {
    const channel = createBackpressureChannel<number>({
      capacity: 5,
      logger: testLogger(),
      label: 'item',
    });

    for (let i = 0; i < 5; i++) channel.push(i);

    const values = await drain(channel.iterable, 5);

    expect(values).toEqual([0, 1, 2, 3, 4]);
  });

  it('evicts the oldest items once the buffer exceeds twice the capacity', async () => {
    const channel = createBackpressureChannel<number>({
      capacity: 5,
      logger: testLogger(),
      label: 'item',
    });

    // 11 pushes crosses the 2x (10) eviction threshold on the 11th push,
    // trimming back down to `capacity` (5): items 0..5 are evicted.
    for (let i = 0; i < 11; i++) channel.push(i);

    const values = await drain(channel.iterable, 5);

    expect(values).toEqual([6, 7, 8, 9, 10]);
  });

  it('logs the eviction exactly once even if the cap is crossed again later', async () => {
    const logger = testLogger();
    const channel = createBackpressureChannel<number>({ capacity: 5, logger, label: 'item' });

    for (let i = 0; i < 30; i++) channel.push(i);

    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('includes the given label in the eviction warning', async () => {
    const logger = testLogger();
    const channel = createBackpressureChannel<number>({ capacity: 5, logger, label: 'widget' });

    for (let i = 0; i < 11; i++) channel.push(i);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('widget buffer exceeded cap'));
  });

  it('never logs when the cap is never crossed', async () => {
    const logger = testLogger();
    const channel = createBackpressureChannel<number>({ capacity: 5, logger, label: 'item' });

    for (let i = 0; i < 5; i++) channel.push(i);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('createBackpressureChannel, terminal error propagation', () => {
  it('rejects a pending pull with the given error when fail is called', async () => {
    const channel = createBackpressureChannel<number>({
      capacity: 10,
      logger: testLogger(),
      label: 'item',
    });
    const iterator = channel.iterable[Symbol.asyncIterator]();
    const pending = iterator.next();

    const error = new Error('boom');
    channel.fail(error);

    await expect(pending).rejects.toThrow('boom');
  });

  it('rejects future pulls with the same error once already failed', async () => {
    const channel = createBackpressureChannel<number>({
      capacity: 10,
      logger: testLogger(),
      label: 'item',
    });
    const iterator = channel.iterable[Symbol.asyncIterator]();

    channel.fail(new Error('boom'));

    await expect(iterator.next()).rejects.toThrow('boom');
    await expect(iterator.next()).rejects.toThrow('boom');
  });

  it('still drains anything already buffered before surfacing the failure', async () => {
    const channel = createBackpressureChannel<number>({
      capacity: 10,
      logger: testLogger(),
      label: 'item',
    });
    const iterator = channel.iterable[Symbol.asyncIterator]();

    channel.push(1);
    channel.fail(new Error('boom'));

    await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 });
    await expect(iterator.next()).rejects.toThrow('boom');
  });

  it.each([undefined, '', 0, null, false] as const)(
    'rejects with a falsy failure value (%p) instead of resolving done: true',
    async (falsyError) => {
      const channel = createBackpressureChannel<number>({
        capacity: 10,
        logger: testLogger(),
        label: 'item',
      });
      const iterator = channel.iterable[Symbol.asyncIterator]();
      const pending = iterator.next();

      channel.fail(falsyError);

      await expect(pending).rejects.toBe(falsyError);
      // A subsequent pull after already-failed must also reject, not resolve done.
      await expect(iterator.next()).rejects.toBe(falsyError);
    },
  );
});

describe('createBackpressureChannel, backpressure once reading', () => {
  it('holds the producer instead of evicting when a reader falls behind', async () => {
    const logger = testLogger();
    const channel = createBackpressureChannel<number>({ capacity: 3, logger, label: 'item' });
    const iterator = channel.iterable[Symbol.asyncIterator]();

    const first = iterator.next();
    expect(channel.push(0)).toBeUndefined();
    await first;

    expect(channel.push(1)).toBeUndefined();
    expect(channel.push(2)).toBeUndefined();
    const space = channel.push(3);
    expect(space).toBeInstanceOf(Promise);

    let released = false;
    void space?.then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 });
    await Promise.resolve();
    expect(released).toBe(true);

    const values = await drain(channel.iterable, 2);
    expect(values).toEqual([2, 3]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('releases a held producer when the channel finishes or fails', async () => {
    const channel = createBackpressureChannel<number>({
      capacity: 1,
      logger: testLogger(),
      label: 'item',
    });
    const iterator = channel.iterable[Symbol.asyncIterator]();
    const first = iterator.next();
    channel.push(0);
    await first;

    const space = channel.push(1);
    channel.fail(new Error('boom'));
    await expect(space).resolves.toBeUndefined();

    const other = createBackpressureChannel<number>({
      capacity: 1,
      logger: testLogger(),
      label: 'item',
    });
    const otherIterator = other.iterable[Symbol.asyncIterator]();
    const otherFirst = otherIterator.next();
    other.push(0);
    await otherFirst;
    const otherSpace = other.push(1);
    other.finish();
    await expect(otherSpace).resolves.toBeUndefined();
  });
});

describe('createBackpressureChannel, early return', () => {
  it('detaches on return: keeps buffered items and releases the producer', async () => {
    const channel = createBackpressureChannel<number>({
      capacity: 1,
      logger: testLogger(),
      label: 'item',
    });
    const iterator = channel.iterable[Symbol.asyncIterator]();
    const first = iterator.next();
    channel.push(0);
    await first;
    const space = channel.push(1);

    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });

    await expect(space).resolves.toBeUndefined();
    // Back to the unread path: pushes never wait, and old items are evicted past 2x.
    expect(channel.push(2)).toBeUndefined();
    const values = await drain(channel.iterable, 2);
    expect(values).toEqual([1, 2]);
  });

  it('lets a later loop continue where a broken loop stopped', async () => {
    const channel = createBackpressureChannel<number>({
      capacity: 10,
      logger: testLogger(),
      label: 'item',
    });
    for (let i = 0; i < 3; i++) channel.push(i);
    channel.finish();

    for await (const _ of channel.iterable) break;
    const rest: number[] = [];
    for await (const value of channel.iterable) rest.push(value);

    expect(rest).toEqual([1, 2]);
  });

  it('settles a pending pull with done when returned', async () => {
    const channel = createBackpressureChannel<number>({
      capacity: 1,
      logger: testLogger(),
      label: 'item',
    });
    const iterator = channel.iterable[Symbol.asyncIterator]();
    const pending = iterator.next();

    await iterator.return?.();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it('only settles the returning reader, leaving other readers active', async () => {
    const channel = createBackpressureChannel<number>({
      capacity: 1,
      logger: testLogger(),
      label: 'item',
    });
    const a = channel.iterable[Symbol.asyncIterator]();
    const b = channel.iterable[Symbol.asyncIterator]();
    const aPending = a.next();
    const bPending = b.next();

    await a.return?.();
    await expect(aPending).resolves.toEqual({ done: true, value: undefined });

    channel.push(1);
    await expect(bPending).resolves.toEqual({ done: false, value: 1 });

    // B is still reading, so a full buffer still holds the producer back.
    channel.push(2);
    expect(channel.push(3)).toBeInstanceOf(Promise);
  });

  it('releases the producer once the last active reader returns', async () => {
    const channel = createBackpressureChannel<number>({
      capacity: 1,
      logger: testLogger(),
      label: 'item',
    });
    const a = channel.iterable[Symbol.asyncIterator]();
    const b = channel.iterable[Symbol.asyncIterator]();
    const aFirst = a.next();
    channel.push(0);
    await aFirst;
    const bFirst = b.next();
    channel.push(1);
    await bFirst;
    const space = channel.push(2);

    await a.return?.();
    await a.return?.();
    let released = false;
    void space?.then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    await b.return?.();
    await expect(space).resolves.toBeUndefined();
  });
});
