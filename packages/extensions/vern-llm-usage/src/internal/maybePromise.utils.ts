export type MaybePromise<T> = T | Promise<T>;

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Runs `next` after `value`, in the same tick when `value` is not a promise. Used where a store may
 * answer synchronously: awaiting a plain value still yields, and a stream's record must not be
 * written between the cost being known and its warning being emitted.
 */
export function andThen(value: MaybePromise<void>, next: () => MaybePromise<void>) {
  return isThenable(value) ? value.then(next) : next();
}
