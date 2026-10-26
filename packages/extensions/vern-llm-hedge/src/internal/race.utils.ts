import type { CallResult } from 'vern-llm';

/** The longest delay `setTimeout` takes; a larger one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Waits for `delayMs`, or for `main` to settle either way, or for `signal` to abort, whichever
 * comes first. `'settled'` covers the last two, since neither leaves anything to hedge. The timer
 * and the abort listener are always cleaned up.
 */
export function raceDelay(
  main: Promise<unknown>,
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<'settled' | 'elapsed'> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('settled');
      return;
    }

    const finish = (outcome: 'settled' | 'elapsed'): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish('settled');
    const timer = setTimeout(() => finish('elapsed'), Math.min(delayMs, MAX_TIMER_MS));

    signal?.addEventListener('abort', onAbort, { once: true });
    main.then(
      () => finish('settled'),
      () => finish('settled'),
    );
  });
}

/** The chain whose result was kept: `0` for the main chain, `1` and up for the hedges, in order. */
export interface Raced {
  result: CallResult;
  winner: number;
}

/**
 * The first chain to succeed, the main chain first in `chains`. A chain that fails leaves the
 * others to answer; when all fail, the main chain's error is the one thrown. The result is exactly
 * what the winner produced, so the core can match it to its chain and cancel the others. When
 * several have already answered, the lowest index wins.
 */
export function firstSuccess(chains: readonly Promise<CallResult>[]): Promise<Raced> {
  return new Promise((resolve, reject) => {
    let failures = 0;
    let mainError: unknown;

    chains.forEach((chain, winner) => {
      chain.then(
        (result) => resolve({ result, winner }),
        (error: unknown) => {
          if (winner === 0) mainError = error;
          failures++;
          if (failures === chains.length) reject(mainError);
        },
      );
    });
  });
}
