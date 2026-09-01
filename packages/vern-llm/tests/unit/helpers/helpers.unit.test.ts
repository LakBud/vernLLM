import { describe, expect, it } from 'vitest';

import {
  at,
  createMockClient,
  createMockStreamingClient,
  isPending,
  scriptedIteratorWithReturn,
} from '../../helpers.js';

/**
 * These exercise `tests/helpers.ts` itself, the shared mock-building
 * utilities every other test file relies on. Most of their surface is
 * already indirectly proven by every test that uses them, but a few
 * defensive branches (an empty script, an out-of-bounds `at()`, the
 * streaming mock's unscripted `create()`) are only ever reached by
 * misusing the helper, which no real test does. Covered directly here
 * instead, so a future change to that defensive behavior is still
 * caught.
 */
describe('createMockClient', () => {
  it('throws a clear error when constructed with an empty script and then called', async () => {
    const { client } = createMockClient([]);

    await expect(
      client.chat.completions.create(
        { model: 'm', max_tokens: 10, messages: [] },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('createMockClient: script is empty');
  });
});

describe('createMockStreamingClient', () => {
  it('throws a clear error when constructed with an empty script and then called', () => {
    const { createStream } = createMockStreamingClient([]);

    expect(() =>
      createStream(
        { model: 'm', max_tokens: 10, messages: [] },
        { signal: new AbortController().signal },
      ),
    ).toThrow('createMockStreamingClient: script is empty');
  });

  it("throws when the mock client's unscripted create() is called, since these mocks are stream-only", async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'hi' }]]);

    await expect(
      client.chat.completions.create(
        { model: 'm', max_tokens: 10, messages: [] },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('createMockStreamingClient: create() was not scripted');
  });
});

describe('at', () => {
  it('returns the element at a valid index', () => {
    expect(at(['a', 'b', 'c'], 1)).toBe('b');
  });

  it('throws a descriptive error for an out-of-bounds index', () => {
    expect(() => at(['a', 'b'], 5)).toThrow('Expected element at index 5, but array has length 2');
  });
});

describe('scriptedIteratorWithReturn', () => {
  it('yields the scripted chunks, then throws failure from next() once exhausted', async () => {
    const failure = new Error('scripted failure');
    const build = scriptedIteratorWithReturn(
      [
        { type: 'text-delta', delta: 'a' },
        { type: 'text-delta', delta: 'b' },
      ],
      failure,
    );
    const iterable = build();
    const iterator = iterable[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'text-delta', delta: 'a' },
    });
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'text-delta', delta: 'b' },
    });
    await expect(iterator.next()).rejects.toBe(failure);
  });

  it('calls the default no-op onReturn when return() is invoked with no callback given', async () => {
    const build = scriptedIteratorWithReturn([], new Error('unused'));
    const iterator = build()[Symbol.asyncIterator]();

    await expect(iterator.return!()).resolves.toEqual({ done: true, value: undefined });
  });

  it('calls a custom onReturn on return(), awaiting it before resolving', async () => {
    let called = false;
    const build = scriptedIteratorWithReturn([], new Error('unused'), async () => {
      called = true;
    });
    const iterator = build()[Symbol.asyncIterator]();

    await iterator.return!();

    expect(called).toBe(true);
  });

  it('propagates a rejection from onReturn instead of swallowing it', async () => {
    const build = scriptedIteratorWithReturn([], new Error('unused'), () => {
      throw new Error('onReturn boom');
    });
    const iterator = build()[Symbol.asyncIterator]();

    await expect(iterator.return!()).rejects.toThrow('onReturn boom');
  });
});

describe('isPending', () => {
  it('returns true for a promise that has not settled after a few microtask ticks', async () => {
    const neverSettles = new Promise(() => {});

    await expect(isPending(neverSettles)).resolves.toBe(true);
  });

  it('returns false for a promise that resolves quickly', async () => {
    await expect(isPending(Promise.resolve('done'))).resolves.toBe(false);
  });

  it('returns false for a promise that rejects quickly', async () => {
    const rejected = Promise.reject(new Error('boom'));
    rejected.catch(() => {}); // avoid an unhandled-rejection warning from this test itself

    await expect(isPending(rejected)).resolves.toBe(false);
  });
});
