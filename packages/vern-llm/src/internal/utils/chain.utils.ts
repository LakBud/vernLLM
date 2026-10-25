import { combineSignals } from '../execution/utils/callSignal.utils.js';

/** Chain number by the signal a chain runs with. Only chains 1 and up are recorded. */
const chainBySignal = new WeakMap<AbortSignal, number>();

/**
 * The signal a chain runs with: its parent's, combined with the chain's own cancel signal.
 * Recorded under `number`, so code that only sees the signal can tell which chain it's in.
 */
export function chainSignal(
  parent: AbortSignal | undefined,
  own: AbortSignal,
  number: number,
): AbortSignal {
  return markChain(combineSignals([parent, own])!, number);
}

/**
 * Records `signal` as belonging to chain `number` and returns it. For a signal derived from a
 * chain's own, such as one that also ends when a stream is left early.
 */
export function markChain(signal: AbortSignal, number: number): AbortSignal {
  if (number > 0) chainBySignal.set(signal, number);
  return signal;
}

/** `{ chain }` to spread into a context, event or meta; empty for the main chain. */
export function chainFields(signal: AbortSignal | undefined): { chain?: number } {
  const chain = signal === undefined ? undefined : chainBySignal.get(signal);
  return chain === undefined ? {} : { chain };
}
