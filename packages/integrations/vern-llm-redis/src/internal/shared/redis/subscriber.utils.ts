import type { RedisSubscriber } from '../../../types.js';

export interface SubscriberHooks {
  /** Checked per message, so nothing arrives after `dispose()`. */
  isDisposed: () => boolean;
  /** Called with messages for `channel` only. */
  onMessage: (message: string) => void;
  /** Called if `subscribe` rejects. */
  onSubscribeError: (error: unknown) => void;
}

/** A detach that also says when the subscription is live. */
export type Detach = (() => void) & {
  /** Settles once `subscribe` succeeds or fails. Never rejects. */
  ready: Promise<void>;
};

/** Adapters per channel per subscriber, so only the last one out unsubscribes. */
const channelUsers = new WeakMap<RedisSubscriber, Map<string, number>>();

/** Subscribes to `channel` and returns a best effort detach. Await `ready` before relying on a prompt wake. */
export function attachSubscriber(
  subscriber: RedisSubscriber,
  channel: string,
  hooks: SubscriberHooks,
): Detach {
  let users = channelUsers.get(subscriber);
  if (!users) {
    users = new Map();
    channelUsers.set(subscriber, users);
  }
  users.set(channel, (users.get(channel) ?? 0) + 1);

  const ready = Promise.resolve(subscriber.subscribe(channel))
    .then(() => undefined)
    .catch((error: unknown) => {
      hooks.onSubscribeError(error);
    });

  const listener = (receivedChannel: string, message: string) => {
    if (hooks.isDisposed() || receivedChannel !== channel) return;
    hooks.onMessage(message);
  };
  subscriber.on('message', listener);

  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;

    // Without `off` the listener stays, inert after dispose.
    subscriber.off?.('message', listener);

    const remaining = users.get(channel)! - 1;
    if (remaining > 0) {
      users.set(channel, remaining);
      return;
    }
    users.delete(channel);

    if (!subscriber.unsubscribe) return;
    void Promise.resolve(subscriber.unsubscribe(channel)).catch(() => {});
  };

  return Object.assign(detach, { ready });
}
