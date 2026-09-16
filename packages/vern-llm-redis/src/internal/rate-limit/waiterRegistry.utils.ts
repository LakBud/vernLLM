/**
 * Tracks callers waiting for a specific Redis key's capacity to free up.
 * Used for the concurrency bucket, which only ever clears via an
 * external release, there's no deterministic refill time to compute the
 * way there is for requests/min or tokens/min.
 *
 * Centralizing register/wake here, rather than inlining a Map<string,
 * Set> directly into the adapter's closures, is what makes wake()
 * cleanup unforgettable rather than merely remembered: a waiter used to
 * only get removed from its set on a timeout or an abort, a message
 * driven wake resolved the waiter's promise but left its entry sitting
 * in the set forever, an unbounded per-key leak over the life of a
 * process. wake() now removes each waiter as part of firing it, in the
 * one place that decision is made, instead of depending on every call
 * site that can resolve a waiter to also remember to clean it up.
 */
export interface WaiterRegistry {
  /**
   * Registers wake for key. Returns a function that removes that
   * specific registration again. Safe to call more than once, a second
   * call is a no-op.
   */
  register(key: string, wake: () => void): () => void;
  /** Fires and removes every waiter currently registered for key. A key with no registered waiters is a no-op. */
  wake(key: string): void;
  /** True if key currently has at least one registered waiter. */
  has(key: string): boolean;
}

export function createWaiterRegistry(): WaiterRegistry {
  const waitersByKey = new Map<string, Set<() => void>>();

  function unregister(key: string, waiter: () => void): void {
    const set = waitersByKey.get(key);
    if (!set) return;

    set.delete(waiter);
    if (set.size === 0) waitersByKey.delete(key);
  }

  return {
    register(key, waiter) {
      let set = waitersByKey.get(key);
      if (!set) {
        set = new Set();
        waitersByKey.set(key, set);
      }
      set.add(waiter);

      return () => unregister(key, waiter);
    },

    wake(key) {
      const waiters = waitersByKey.get(key);
      if (!waiters) return;

      for (const waiter of [...waiters]) {
        unregister(key, waiter);
        waiter();
      }
    },

    has(key) {
      return waitersByKey.has(key);
    },
  };
}
