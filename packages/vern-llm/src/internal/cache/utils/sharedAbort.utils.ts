import { LLMError } from '../../../types/errors.js';
import { detachChunks } from '../../execution/utils/stream/chunkBuffer.utils.js';

import type { StreamChunk } from '../../../types/stream.js';

/**
 * An abort signal owned by every caller coalesced onto one in-flight
 * operation, rather than by whichever caller happened to start it. It
 * only fires once the last participant has left, so one caller's abort
 * or deadline never cancels work other callers are still waiting on.
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
 * Relays `chunks` until `signal` fires, then throws an `aborted` LLMError
 * from this caller's iteration. The underlying stream is left running for
 * any other participant: stopping early, whether by abort or a `break`,
 * detaches this caller instead of cancelling the shared stream, and a
 * detached reader no longer holds the stream back.
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
        detachChunks(chunks);
      }
    },
  };
}
