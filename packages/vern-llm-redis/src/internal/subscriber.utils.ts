import type { RedisSubscriber } from '../types.js';

export interface SubscriberHooks {
  /** Checked on every message, so nothing is delivered after `dispose()`. */
  isDisposed: () => boolean;
  /** Called with the raw message for `channel` only. Other channels are ignored. */
  onMessage: (message: string) => void;
  /** Called if the initial `subscribe` rejects, so the adapter can fall back to polling or just report it. */
  onSubscribeError: (error: unknown) => void;
}

/** A detach function that also says when the subscription is live. */
export type Detach = (() => void) & {
  /** Settles once `subscribe` is confirmed or has failed. Never rejects, a failure is already reported through `onSubscribeError`. */
  ready: Promise<void>;
};

/**
 * Subscribes to one channel and returns a function that detaches from it.
 * The detach is best effort: a closing client failing to unsubscribe is
 * expected during shutdown and must never throw out of `dispose()`.
 *
 * A message published before `subscribe` is confirmed is never delivered,
 * so a caller that depends on a prompt wake can await `detach.ready` first.
 */
export function attachSubscriber(
  subscriber: RedisSubscriber,
  channel: string,
  hooks: SubscriberHooks,
): Detach {
  const ready = Promise.resolve(subscriber.subscribe(channel))
    .then(() => undefined)
    .catch((error: unknown) => {
      hooks.onSubscribeError(error);
    });

  subscriber.on('message', (receivedChannel, message) => {
    if (hooks.isDisposed() || receivedChannel !== channel) return;
    hooks.onMessage(message);
  });

  const detach = () => {
    if (!subscriber.unsubscribe) return;
    void Promise.resolve(subscriber.unsubscribe(channel)).catch(() => {});
  };

  return Object.assign(detach, { ready });
}
