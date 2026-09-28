import { describe, expect, it, vi } from 'vitest';

import { attachSubscriber } from '../../../../../src/internal/shared/redis/subscriber.utils.js';
import { fakeSubscriber } from '../../../../helpers.js';

function hooks(overrides: Partial<Parameters<typeof attachSubscriber>[2]> = {}) {
  return {
    isDisposed: () => false,
    onMessage: vi.fn(),
    onSubscribeError: vi.fn(),
    ...overrides,
  };
}

describe('attachSubscriber', () => {
  it('subscribes to the channel', () => {
    const subscriber = fakeSubscriber();
    attachSubscriber(subscriber, 'chan', hooks());

    expect(subscriber.subscribe).toHaveBeenCalledWith('chan');
  });

  it('delivers messages from its own channel only', () => {
    const subscriber = fakeSubscriber();
    const h = hooks();
    attachSubscriber(subscriber, 'chan', h);

    subscriber.emit('chan', 'hello');
    subscriber.emit('other', 'ignored');

    expect(h.onMessage).toHaveBeenCalledOnce();
    expect(h.onMessage).toHaveBeenCalledWith('hello');
  });

  it('delivers nothing once disposed', () => {
    const subscriber = fakeSubscriber();
    const h = hooks({ isDisposed: () => true });
    attachSubscriber(subscriber, 'chan', h);

    subscriber.emit('chan', 'hello');
    expect(h.onMessage).not.toHaveBeenCalled();
  });

  it('reports a rejected subscribe instead of leaving it unhandled', async () => {
    const subscriber = fakeSubscriber();
    const error = new Error('no connection');
    subscriber.subscribe.mockRejectedValue(error);
    const h = hooks();
    attachSubscriber(subscriber, 'chan', h);

    await vi.waitFor(() => expect(h.onSubscribeError).toHaveBeenCalledWith(error));
  });

  it('detaches through unsubscribe when the client has one', () => {
    const subscriber = { ...fakeSubscriber(), unsubscribe: vi.fn(async () => undefined) };
    const detach = attachSubscriber(subscriber, 'chan', hooks());

    detach();
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('chan');
  });

  it('swallows a failing or synchronous unsubscribe, since a closing client is expected to fail', async () => {
    const failing = {
      ...fakeSubscriber(),
      unsubscribe: vi.fn(async () => Promise.reject(new Error('closed'))),
    };
    expect(() => attachSubscriber(failing, 'chan', hooks())()).not.toThrow();

    const sync = { ...fakeSubscriber(), unsubscribe: vi.fn(() => undefined) };
    expect(() => attachSubscriber(sync, 'chan', hooks())()).not.toThrow();

    await Promise.resolve();
  });

  it('detaches as a no-op when the client has no unsubscribe', () => {
    const detach = attachSubscriber(fakeSubscriber(), 'chan', hooks());
    expect(() => detach()).not.toThrow();
  });
});

describe('attachSubscriber ready', () => {
  it('settles only once subscribe is confirmed', async () => {
    let confirm!: () => void;
    const subscriber = fakeSubscriber();
    subscriber.subscribe.mockImplementation(
      () => new Promise<void>((resolve) => (confirm = resolve)),
    );
    let settled = false;
    void attachSubscriber(subscriber, 'chan', hooks()).ready.then(() => (settled = true));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    confirm();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(true);
  });

  it('settles, without rejecting, when subscribe fails, and reports the error', async () => {
    const subscriber = fakeSubscriber();
    const boom = new Error('boom');
    subscriber.subscribe.mockRejectedValue(boom);
    const h = hooks();

    await expect(attachSubscriber(subscriber, 'chan', h).ready).resolves.toBeUndefined();
    expect(h.onSubscribeError).toHaveBeenCalledWith(boom);
  });

  it('removes its own message listener on detach', () => {
    const subscriber = fakeSubscriber();
    const detach = attachSubscriber(subscriber, 'chan', hooks());
    expect(subscriber.listenerCount()).toBe(1);

    detach();

    expect(subscriber.listenerCount()).toBe(0);
  });

  it('only unsubscribes once the last adapter on that channel detaches', () => {
    const subscriber = Object.assign(fakeSubscriber(), {
      unsubscribe: vi.fn(async () => undefined),
    });
    const first = hooks();
    const second = hooks();
    const detachFirst = attachSubscriber(subscriber, 'chan', first);
    const detachSecond = attachSubscriber(subscriber, 'chan', second);

    detachFirst();
    detachFirst(); // a repeat detach must not count twice
    expect(subscriber.unsubscribe).not.toHaveBeenCalled();

    subscriber.emit('chan', 'still here');
    expect(second.onMessage).toHaveBeenCalledWith('still here');
    expect(first.onMessage).not.toHaveBeenCalled();

    detachSecond();
    expect(subscriber.unsubscribe).toHaveBeenCalledOnce();
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('chan');
  });

  it('counts each channel and each subscriber on its own', () => {
    const a = Object.assign(fakeSubscriber(), { unsubscribe: vi.fn(async () => undefined) });
    const b = Object.assign(fakeSubscriber(), { unsubscribe: vi.fn(async () => undefined) });
    attachSubscriber(a, 'one', hooks());
    const detachTwo = attachSubscriber(a, 'two', hooks());
    const detachOnB = attachSubscriber(b, 'one', hooks());

    detachTwo();
    detachOnB();

    expect(a.unsubscribe).toHaveBeenCalledExactlyOnceWith('two');
    expect(b.unsubscribe).toHaveBeenCalledExactlyOnceWith('one');
  });

  it('subscribes again for a channel attached after its last user left', () => {
    const subscriber = Object.assign(fakeSubscriber(), {
      unsubscribe: vi.fn(async () => undefined),
    });
    attachSubscriber(subscriber, 'chan', hooks())();

    attachSubscriber(subscriber, 'chan', hooks());

    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
  });

  it('leaves an inert listener behind on a subscriber without off', () => {
    const subscriber = fakeSubscriber();
    delete (subscriber as { off?: unknown }).off;
    let disposed = false;
    const h = hooks({ isDisposed: () => disposed });
    const detach = attachSubscriber(subscriber, 'chan', h);

    disposed = true;
    detach();
    subscriber.emit('chan', 'late');

    expect(h.onMessage).not.toHaveBeenCalled();
  });
});
