/**
 * Tracks callers waiting for a specific Redis key's capacity to free up.
 * Used for the concurrency bucket, which only clears via an external
 * release, unlike requests/min or tokens/min which have a deterministic
 * refill time.
 *
 * Centralized here so wake() always removes a waiter as it fires it,
 * instead of relying on every call site to remember cleanup, which
 * previously leaked a waiter's entry whenever a message resolved it.
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
