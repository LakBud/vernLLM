/** A memoized async call, returned by `createOnceAsync`. */
export interface OnceAsync<T> {
  /**
   * Calls the wrapped function on the first invocation; every later call
   * returns that same promise, whether it has settled yet or not.
   */
  call(): Promise<T>;
  /** Whether `call()` has been invoked yet. */
  wasCalled(): boolean;
  /**
   * The value `call()`'s promise resolved to, once it has. Stays
   * `undefined` before that settles, and if it rejects instead.
   */
  resolvedValue(): T | undefined;
}

/**
 * Wraps an async function so repeated calls dispatch it at most once,
 * reusing the first call's promise for every later one, and so a caller
 * that invokes `call()` and then discards the returned promise (e.g.
 * after deciding to short circuit) doesn't leave an unhandled rejection
 * behind if that promise later rejects.
 *
 * Pulled out of `runOperation`'s `next()` wrapper, where a middleware's
 * `wrap` may call `next()` more than once, or not await what it returns.
 * Generic and self contained: nothing here depends on `CallResult` or
 * middleware.
 */
export function createOnceAsync<T>(fn: () => Promise<T>): OnceAsync<T> {
  let called = false;
  let resolved: T | undefined;
  let promise: Promise<T> | undefined;

  function call(): Promise<T> {
    if (promise) return promise;

    called = true;

    // Not `async`: assigning `promise` here, synchronously, before any
    // `await`, is what makes two `call()`s issued back to back with no
    // `await` between them (e.g. `Promise.all([call(), call()])`) still
    // see the first call's promise already in place.
    promise = fn().then((value) => {
      resolved = value;
      return value;
    });

    // The promise returned below is untouched, so its own rejection
    // still propagates normally to anyone who does await it. This
    // separate handle only exists to swallow a rejection nobody else
    // ever observes.
    promise.catch(() => {});

    return promise;
  }

  return {
    call,
    wasCalled: () => called,
    resolvedValue: () => resolved,
  };
}
