/** A keyed registry of in-flight promises, returned by `createInFlightRegistry`. */
export interface InFlightRegistry<T> {
  /** The promise currently tracked under `key`, if any. */
  get(key: string): Promise<T> | undefined;
  /**
   * Registers `promise` under `key` synchronously and removes it once it settles. Returns `promise`
   * unchanged.
   */
  track(key: string, promise: Promise<T>): Promise<T>;
}

/** At most one in-flight promise per key, removed once it settles. */
export function createInFlightRegistry<T>(): InFlightRegistry<T> {
  const inFlight = new Map<string, Promise<T>>();

  function get(key: string): Promise<T> | undefined {
    return inFlight.get(key);
  }

  function track(key: string, promise: Promise<T>): Promise<T> {
    inFlight.set(key, promise);

    // The promise returned below is untouched, so its own rejection
    // still propagates normally to anyone who does await it. This
    // separate handle only exists so cleanup doesn't itself surface an
    // unhandled rejection for a promise nobody else observes.
    void promise
      .catch(() => {})
      .finally(() => {
        // Only remove this entry if it's still the one registered under
        // `key`: a newer `track()` call for the same key may have
        // already replaced it, and that replacement must survive this
        // (older) promise settling later.
        if (inFlight.get(key) === promise) {
          inFlight.delete(key);
        }
      });

    return promise;
  }

  return { get, track };
}
