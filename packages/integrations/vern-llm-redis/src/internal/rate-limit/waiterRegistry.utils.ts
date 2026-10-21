/** Callers waiting for a concurrency key to free. `wake` removes each waiter it fires. */
export interface WaiterRegistry {
  /** Registers `wake` for `key`. Returns an idempotent unregister. */
  register(key: string, wake: () => void): () => void;
  /** Fires and removes the waiters for `key`, or keeps one wake for the next registration. */
  wake(key: string): void;
  /** Whether `key` has a waiter. */
  has(key: string): boolean;
}

export function createWaiterRegistry(): WaiterRegistry {
  const waitersByKey = new Map<string, Set<() => void>>();
  const pendingWakes = new Set<string>();

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

      if (pendingWakes.delete(key)) {
        unregister(key, waiter);
        waiter();
      }

      return () => unregister(key, waiter);
    },

    wake(key) {
      const waiters = waitersByKey.get(key);
      if (!waiters) {
        pendingWakes.add(key);
        return;
      }

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
