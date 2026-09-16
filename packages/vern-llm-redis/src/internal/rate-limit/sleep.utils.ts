import { LLMError } from 'vern-llm';

import type { WaiterRegistry } from './waiterRegistry.utils.js';

/** Sleeps ms, or resolves early (rejecting) the moment signal aborts. */
export function sleepOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LLMError('Rate limit wait aborted', 'aborted'));
      return;
    }

    const timer = setTimeout(resolve, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new LLMError('Rate limit wait aborted', 'aborted'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Waits for registry to wake key, or pollIntervalMs, whichever comes
 * first. Used only for the concurrency bucket, which has no
 * deterministic refill time to sleep for instead.
 */
export function waitForWakeOrPoll(
  registry: WaiterRegistry,
  key: string,
  pollIntervalMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
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
