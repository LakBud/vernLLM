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
});
