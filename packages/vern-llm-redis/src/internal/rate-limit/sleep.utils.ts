import { LLMError } from 'vern-llm';

import type { WaiterRegistry } from './waiterRegistry.utils.js';

/** Sleeps ms, or resolves early (rejecting) the moment signal aborts. */
export function sleepOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LLMError('Rate limit wait aborted', 'aborted'));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(new LLMError('Rate limit wait aborted', 'aborted'));
    };

    const timer = setTimeout(() => {
      // Removed explicitly, so a shared signal doesn't collect dead listeners.
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Waits for a wake on `key`, or `pollIntervalMs`, whichever is first. */
export function waitForWakeOrPoll(
  registry: WaiterRegistry,
  key: string,
  pollIntervalMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LLMError('Rate limit wait aborted', 'aborted'));
      return;
    }

    let unregister: (() => void) | undefined;
    let onAbort: (() => void) | undefined;

    const timer = setTimeout(() => {
      unregister?.();
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve();
    }, pollIntervalMs);

    const wake = () => {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve();
    };

    unregister = registry.register(key, wake);

    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        unregister?.();
        reject(new LLMError('Rate limit wait aborted', 'aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
