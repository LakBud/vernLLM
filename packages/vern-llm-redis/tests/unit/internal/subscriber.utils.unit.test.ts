import { describe, expect, it, vi } from 'vitest';

import { attachSubscriber } from '../../../src/internal/subscriber.utils.js';
import { fakeSubscriber } from '../../helpers.js';

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
