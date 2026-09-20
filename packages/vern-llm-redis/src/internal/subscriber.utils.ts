import type { RedisSubscriber } from '../types.js';

export interface SubscriberHooks {
  /** Checked on every message, so nothing is delivered after `dispose()`. */
  isDisposed: () => boolean;
  /** Called with the raw message for `channel` only. Other channels are ignored. */
  onMessage: (message: string) => void;
  /** Called if the initial `subscribe` rejects, so the adapter can fall back to polling or just report it. */
  onSubscribeError: (error: unknown) => void;
}

/**
 * Subscribes to one channel and returns a function that detaches from it.
 * The detach is best effort: a closing client failing to unsubscribe is
 * expected during shutdown and must never throw out of `dispose()`.
 */
export function attachSubscriber(
  subscriber: RedisSubscriber,
  channel: string,
  hooks: SubscriberHooks,
): () => void {
  void subscriber.subscribe(channel).catch(hooks.onSubscribeError);

  subscriber.on('message', (receivedChannel, message) => {
    if (hooks.isDisposed() || receivedChannel !== channel) return;
    hooks.onMessage(message);
  });

  return () => {
    if (!subscriber.unsubscribe) return;
    void Promise.resolve(subscriber.unsubscribe(channel)).catch(() => {});
  };
}
