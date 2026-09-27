import { setupDeadline } from './deadline.utils.js';

/** One signal that aborts when any given signal does, or `undefined` when none is given. */
export function combineSignals(
  signals: readonly (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length > 1 ? AbortSignal.any(present) : present[0];
}

export interface CallSignalSetup<P> {
  /** `params` with the effective signal, or `params` itself when nothing was added. */
  params: P;
  signal: AbortSignal | undefined;
  /** Aborted when the caller stops reading `chunks` early. Only set for a cancellable stream. */
  breakController: AbortController | undefined;
  dispose: () => void;
}

/**
 * Joins the caller signal, a break controller for streams, and `deadlineMs` into the
 * one signal the rest of the call reads. `cancellable` is false for `cachedCall()`'s
 * inner call, whose stream is shared and left by the cache instead.
 */
export function setupCallSignal<
  P extends { signal?: AbortSignal; deadlineMs?: number; stream?: boolean },
>(params: P, cancellable: boolean): CallSignalSetup<P> {
  const breakController = params.stream && cancellable ? new AbortController() : undefined;
  const { signal, timer } = setupDeadline(
    params.deadlineMs,
    combineSignals([params.signal, breakController?.signal]),
  );

  return {
    params: signal === params.signal ? params : { ...params, signal },
    signal,
    breakController,
    dispose: () => clearTimeout(timer),
  };
}
