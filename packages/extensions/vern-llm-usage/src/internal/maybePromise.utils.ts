export type MaybePromise<T> = T | Promise<T>;

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Runs `next` after `value`, in the same tick when it is not a promise. */
export function andThen(value: MaybePromise<void>, next: () => MaybePromise<void>) {
  return isThenable(value) ? value.then(next) : next();
}
