import { describe, expect, it, vi } from 'vitest';

import { fromNodeRedis, fromNodeRedisSubscriber } from '../../../src/clients/nodeRedis.js';

describe('fromNodeRedis', () => {
  it('forwards get unchanged', async () => {
    const client = {
      get: vi.fn().mockResolvedValue('v'),
      set: vi.fn(),
      del: vi.fn(),
      eval: vi.fn(),
    };
    const wrapped = fromNodeRedis(client);

    await expect(wrapped.get('k')).resolves.toBe('v');
    expect(client.get).toHaveBeenCalledWith('k');
  });

  it('translates set(key, value, "PX", ms) into set(key, value, { PX: ms })', async () => {
    const client = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn(),
      eval: vi.fn(),
    };
    const wrapped = fromNodeRedis(client);

    await wrapped.set('k', 'v', 'PX', 5000);

    expect(client.set).toHaveBeenCalledWith('k', 'v', { PX: 5000 });
  });

  it('translates variadic del(...keys) into del(keys) as an array', async () => {
    const client = { get: vi.fn(), set: vi.fn(), del: vi.fn().mockResolvedValue(1), eval: vi.fn() };
    const wrapped = fromNodeRedis(client);

    await wrapped.del('a', 'b', 'c');

    expect(client.del).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it("splits eval's positional (script, numKeys, ...args) into node-redis's { keys, arguments }", async () => {
    const client = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      eval: vi.fn().mockResolvedValue('ok'),
    };
    const wrapped = fromNodeRedis(client);

    await wrapped.eval('return 1', 2, 'key1', 'key2', 'arg1', 42);

    expect(client.eval).toHaveBeenCalledWith('return 1', {
      keys: ['key1', 'key2'],
      arguments: ['arg1', '42'],
    });
  });

  it('handles zero keys correctly', async () => {
    const client = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      eval: vi.fn().mockResolvedValue('ok'),
    };
    const wrapped = fromNodeRedis(client);

    await wrapped.eval('return ARGV[1]', 0, 'onlyArg');

    expect(client.eval).toHaveBeenCalledWith('return ARGV[1]', {
      keys: [],
      arguments: ['onlyArg'],
    });
  });
});

describe('fromNodeRedisSubscriber', () => {
  it('subscribes with a translated per-channel callback and re-emits as (channel, message)', async () => {
    let capturedListener: ((message: string, channel: string) => void) | undefined;
    const client = {
      subscribe: vi.fn(
        async (_channel: string, listener: (message: string, channel: string) => void) => {
          capturedListener = listener;
        },
      ),
    };

    const subscriber = fromNodeRedisSubscriber(client);
    const onMessage = vi.fn();
    subscriber.on('message', onMessage);

    await subscriber.subscribe('ch');
    expect(client.subscribe).toHaveBeenCalledWith('ch', expect.any(Function));

    capturedListener?.('hello', 'ch');
    expect(onMessage).toHaveBeenCalledWith('ch', 'hello');
  });

  it('supports more than one listener', async () => {
    let capturedListener: ((message: string, channel: string) => void) | undefined;
    const client = {
      subscribe: vi.fn(
        async (_channel: string, listener: (message: string, channel: string) => void) => {
          capturedListener = listener;
        },
      ),
    };

    const subscriber = fromNodeRedisSubscriber(client);
    const first = vi.fn();
    const second = vi.fn();
    subscriber.on('message', first);
    subscriber.on('message', second);

    await subscriber.subscribe('ch');
    capturedListener?.('hello', 'ch');

    expect(first).toHaveBeenCalledWith('ch', 'hello');
    expect(second).toHaveBeenCalledWith('ch', 'hello');
  });

  it('does not call client.subscribe again for a channel already subscribed to', async () => {
    const client = { subscribe: vi.fn(async () => undefined) };
    const subscriber = fromNodeRedisSubscriber(client);

    await subscriber.subscribe('ch');
    await subscriber.subscribe('ch');

    expect(client.subscribe).toHaveBeenCalledTimes(1);
  });

  it('ignores a registration for an event other than "message"', async () => {
    let capturedListener: ((message: string, channel: string) => void) | undefined;
    const client = {
      subscribe: vi.fn(
        async (_channel: string, listener: (message: string, channel: string) => void) => {
          capturedListener = listener;
        },
      ),
    };

    const subscriber = fromNodeRedisSubscriber(client);
    const onMessage = vi.fn();
    // Bypasses the type system deliberately: `on`'s real signature only
    // accepts 'message', this exercises the runtime guard against a
    // caller that ignores that, e.g. plain JS or an `as any` escape.
    (subscriber.on as (event: string, listener: typeof onMessage) => unknown)('other', onMessage);

    await subscriber.subscribe('ch');
    capturedListener?.('hello', 'ch');

    expect(onMessage).not.toHaveBeenCalled();
  });
});
