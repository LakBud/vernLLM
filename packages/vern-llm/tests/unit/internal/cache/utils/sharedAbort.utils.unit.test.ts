import { describe, it, expect, vi } from 'vitest';

import {
  abortableChunks,
  createSharedAbort,
  raceAbort,
} from '../../../../../src/internal/cache/utils/sharedAbort.utils.js';
import { createBackpressureChannel } from '../../../../../src/internal/execution/utils/stream/chunkBuffer.utils.js';
import { isLLMError } from '../../../../../src/types/errors.js';

import type { StreamChunk } from '../../../../../src/types/index.js';

const isAborted = (error: unknown) => isLLMError(error) && error.type === 'aborted';

describe('createSharedAbort', () => {
  it('counts participants and aborts only once the last one leaves', () => {
    const shared = createSharedAbort();
    const releaseA = shared.join();
    const releaseB = shared.join();
    expect(shared.participants).toBe(2);

    releaseA();
    expect(shared.signal.aborted).toBe(false);

    releaseB();
    expect(shared.participants).toBe(0);
    expect(shared.signal.aborted).toBe(true);
    expect(isAborted(shared.signal.reason)).toBe(true);
  });

  it('ignores a repeated release from the same participant', () => {
    const shared = createSharedAbort();
    const releaseA = shared.join();
    shared.join();

    releaseA();
    releaseA();

    expect(shared.participants).toBe(1);
    expect(shared.signal.aborted).toBe(false);
  });

  it('never aborts once settled', () => {
    const shared = createSharedAbort();
    const release = shared.join();

    shared.settle();
    release();

    expect(shared.signal.aborted).toBe(false);
  });

  it('does not abort twice when a new participant joins and leaves after an abort', () => {
    const shared = createSharedAbort();
    shared.join()();
    const reason: unknown = shared.signal.reason;

    shared.join()();

    expect(shared.signal.reason).toBe(reason);
  });
});

describe('raceAbort', () => {
  it('returns the promise unchanged without a signal', () => {
    const promise = Promise.resolve(1);
    expect(raceAbort(promise, undefined)).toBe(promise);
  });

  it('rejects right away for an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      raceAbort(Promise.reject(new Error('shared')), controller.signal),
    ).rejects.toSatisfy(isAborted);
  });

  it('resolves with the promise when the signal never fires', async () => {
    await expect(raceAbort(Promise.resolve('ok'), new AbortController().signal)).resolves.toBe(
      'ok',
    );
  });

  it('rejects with the promise error when the signal never fires', async () => {
    const error = new Error('boom');
    await expect(raceAbort(Promise.reject(error), new AbortController().signal)).rejects.toBe(
      error,
    );
  });

  it('rejects as aborted when the signal fires first', async () => {
    const controller = new AbortController();
    const raced = raceAbort(new Promise(() => {}), controller.signal);

    controller.abort();

    await expect(raced).rejects.toSatisfy(isAborted);
  });
});

describe('abortableChunks', () => {
  const chunk: StreamChunk = { type: 'text-delta', delta: 'a' };

  function source(items: StreamChunk[], hang = false): AsyncIterable<StreamChunk> {
    return {
      async *[Symbol.asyncIterator]() {
        yield* items;
        if (hang) await new Promise(() => {});
      },
    };
  }

  it('relays every chunk without a signal', async () => {
    const out: StreamChunk[] = [];
    for await (const c of abortableChunks(source([chunk, chunk]), undefined)) out.push(c);
    expect(out).toEqual([chunk, chunk]);
  });

  it('detaches the source when the caller breaks out early', async () => {
    const channel = createBackpressureChannel<StreamChunk>({
      capacity: 10,
      logger: { warn: vi.fn() },
      label: 'test',
    });
    channel.push(chunk);
    channel.push(chunk);

    for await (const _ of abortableChunks(channel.iterable, undefined)) break;

    // Detached: the producer is never held back after the caller left.
    for (let i = 0; i < 50; i++) expect(channel.push(chunk)).toBeUndefined();
  });

  it('relays every chunk when the signal never fires', async () => {
    const out: StreamChunk[] = [];
    for await (const c of abortableChunks(source([chunk, chunk]), new AbortController().signal)) {
      out.push(c);
    }
    expect(out).toEqual([chunk, chunk]);
  });

  it('throws aborted from iteration once the signal fires', async () => {
    const controller = new AbortController();
    const iterator = abortableChunks(source([chunk], true), controller.signal)[
      Symbol.asyncIterator
    ]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: chunk });
    const pending = iterator.next();
    controller.abort();

    await expect(pending).rejects.toSatisfy(isAborted);
  });
});
