import { describe, expect, it, vi } from 'vitest';

vi.mock('ioredis', () => {
  const Redis = vi.fn();
  return { Redis };
});

vi.mock('redis', () => {
  const createClient = vi.fn();
  return { createClient };
});

import { Redis } from 'ioredis';
import { createClient } from 'redis';

import {
  NEAR_INSTANT_MS,
  connect,
  connectNodeRedis,
  createMockClient,
  expectNearInstant,
  fakeSubscriber,
  uniquePrefix,
  waitUntil,
} from '../../helpers.js';

describe('fakeSubscriber', () => {
  it('ignores a registration for an event other than "message"', () => {
    const subscriber = fakeSubscriber();
    const onMessage = vi.fn();

    // Bypasses the type system deliberately, same reasoning as the
    // equivalent test for fromNodeRedisSubscriber's real 'on' guard:
    // exercises the runtime check a caller that ignores types would hit.
    (subscriber.on as (event: string, listener: typeof onMessage) => unknown)('other', onMessage);

    subscriber.emit('ch', 'hello');

    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe('expectNearInstant', () => {
  it('does not throw for a duration well under the threshold', () => {
    expect(() => expectNearInstant(0)).not.toThrow();
    expect(() => expectNearInstant(NEAR_INSTANT_MS - 1)).not.toThrow();
  });

  it('throws once the duration reaches the threshold, inclusive', () => {
    expect(() => expectNearInstant(NEAR_INSTANT_MS)).toThrow(/near-instant/);
  });

  it('throws for a duration well past the threshold, with both numbers in the message', () => {
    expect(() => expectNearInstant(NEAR_INSTANT_MS + 250)).toThrow(
      new RegExp(`${NEAR_INSTANT_MS}ms.*${NEAR_INSTANT_MS + 250}ms`),
    );
  });
});

describe('connect', () => {
  it('constructs an ioredis client pointed at the local instance, not lazily connected', () => {
    const MockedRedis = vi.mocked(Redis);
    MockedRedis.mockClear();

    connect();

    expect(MockedRedis).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 6379,
      lazyConnect: false,
    });
  });
});

describe('connectNodeRedis', () => {
  it('constructs a node-redis client pointed at the local instance and awaits connect()', async () => {
    const connectMock = vi.fn().mockResolvedValue(undefined);
    const fakeClient = { connect: connectMock };
    vi.mocked(createClient).mockReturnValueOnce(fakeClient as never);

    const client = await connectNodeRedis();

    expect(createClient).toHaveBeenCalledWith({ socket: { host: '127.0.0.1', port: 6379 } });
    expect(connectMock).toHaveBeenCalled();
    expect(client).toBe(fakeClient);
  });
});

describe('uniquePrefix', () => {
  it('prefixes the given base with a timestamp and a random suffix', () => {
    const prefix = uniquePrefix('cb');

    expect(prefix).toMatch(/^cb:\d+:[a-z0-9]+$/);
  });

  it('produces a different value on each call, even for the same base', () => {
    const first = uniquePrefix('cb');
    const second = uniquePrefix('cb');

    expect(first).not.toBe(second);
  });
});

describe('createMockClient', () => {
  it('throws if the client is invoked with an empty script', async () => {
    const { client } = createMockClient([]);

    await expect(
      client.chat.completions.create(
        { model: 'm', max_tokens: 1, messages: [] },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('script is empty');
  });

  it('resolves with the scripted content on a successful entry', async () => {
    const { client } = createMockClient([{ content: 'hello' }]);

    await expect(
      client.chat.completions.create(
        { model: 'm', max_tokens: 1, messages: [] },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ choices: [{ message: { content: 'hello' } }] });
  });

  it('rejects with the scripted error on an Error entry', async () => {
    const boom = new Error('boom');
    const { client } = createMockClient([boom]);

    await expect(
      client.chat.completions.create(
        { model: 'm', max_tokens: 1, messages: [] },
        { signal: new AbortController().signal },
      ),
    ).rejects.toBe(boom);
  });

  it('repeats the last scripted entry once the queue runs out', async () => {
    const { client, create } = createMockClient([{ content: 'first' }, { content: 'last' }]);
    const params = { model: 'm', max_tokens: 1, messages: [] };
    const opts = { signal: new AbortController().signal };

    await expect(client.chat.completions.create(params, opts)).resolves.toEqual({
      choices: [{ message: { content: 'first' } }],
    });
    await expect(client.chat.completions.create(params, opts)).resolves.toEqual({
      choices: [{ message: { content: 'last' } }],
    });
    await expect(client.chat.completions.create(params, opts)).resolves.toEqual({
      choices: [{ message: { content: 'last' } }],
    });

    expect(create).toHaveBeenCalledTimes(3);
  });
});

describe('waitUntil', () => {
  it('resolves as soon as the condition becomes true', async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 10);

    await expect(waitUntil(() => ready)).resolves.toBeUndefined();
  });

  it('supports an async condition', async () => {
    await expect(waitUntil(async () => true)).resolves.toBeUndefined();
  });

  it('throws once timeoutMs elapses without the condition ever becoming true', async () => {
    await expect(waitUntil(() => false, { timeoutMs: 30, intervalMs: 10 })).rejects.toThrow(
      /condition not met within 30ms/,
    );
  });
});
