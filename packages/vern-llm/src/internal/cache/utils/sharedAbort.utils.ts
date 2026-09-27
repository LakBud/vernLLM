import { LLMError } from '../../../types/errors.js';

import type { StreamChunk } from '../../../types/stream.js';

/**
 * A signal owned by every caller coalesced onto one operation. It fires only once the last one has
 * left, so one caller's abort never cancels work others still wait on.
 */
export interface SharedAbort {
  /** Passed to the shared operation. Fires only when no participant remains. */
  readonly signal: AbortSignal;
  /** Number of callers still waiting on the shared operation. */
  readonly participants: number;
  /** Registers a participant. Returns an idempotent release function. */
  join(): () => void;
  /** Marks the shared operation settled, so a later release never aborts it. */
  settle(): void;
}

export function createSharedAbort(): SharedAbort {
  const controller = new AbortController();
  let participants = 0;
  let settled = false;

  return {
    signal: controller.signal,
    get participants() {
      return participants;
    },
    join() {
      participants++;
      let released = false;

      return () => {
        if (released) return;
        released = true;
        participants--;

        if (participants === 0 && !settled && !controller.signal.aborted) {
          controller.abort(new LLMError('LLM request aborted', 'aborted'));
        }
      };
    },
    settle() {
      settled = true;
    },
  };
}

function abortedError(): LLMError {
  return new LLMError('LLM request aborted', 'aborted');
}

/**
 * Settles with `promise`, or rejects with an `aborted` LLMError as soon as
 * `signal` fires, whichever comes first. `promise` itself keeps running;
 * only this caller stops waiting on it.
 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;

  if (signal.aborted) {
    // Observed so an unawaited rejection of the shared promise stays quiet.
    promise.catch(() => {});
    return Promise.reject(abortedError());
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Relays `chunks` until `signal` fires, then throws `aborted` for this caller only. Leaving early
 * detaches this reader and leaves the shared stream running for the others.
 */
export function abortableChunks(
  chunks: AsyncIterable<StreamChunk>,
  signal: AbortSignal | undefined,
): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = chunks[Symbol.asyncIterator]();

      try {
        while (true) {
          const next = await raceAbort(iterator.next(), signal);
          if (next.done) return;
          yield next.value;
        }
      } finally {
        // An async generator's own early exit doesn't close the iterator it
        // reads from, so close it here. On a stream channel that detaches
        // this reader instead of cancelling the stream.
        void Promise.resolve(iterator.return?.()).catch(() => {});
      }
    },
  };
}
