import type { Logger } from '../../../../logger.js';

/** Everything `createBackpressureChannel` needs. Generic over the item type: no knowledge of `StreamChunk`. */
export interface BackpressureChannelOptions {
  /**
   * Hard cap on buffered items once nothing is pulling. The buffer is
   * allowed to grow to twice this before it trims back down in one
   * batch, so eviction cost stays cheap per push (see the eviction
   * comment inside `createBackpressureChannel`).
   */
  capacity: number;
  logger: Pick<Logger, 'warn'>;
  /**
   * Folded into the eviction warning so different channels are
   * distinguishable in logs, e.g. `'stream chunk'`.
   */
  label: string;
}

/** A push/pull async channel with a bounded buffer, returned by `createBackpressureChannel`. */
export interface BackpressureChannel<T> {
  /** Delivers `value` to a waiting puller, or buffers it. */
  push(value: T): void;
  /** Marks the channel done. Every future pull resolves `{ done: true }`. */
  finish(): void;
  /** Marks the channel failed. Every future pull rejects with `error`. */
  fail(error: unknown): void;
  /** Consumed by callers to pull values as they arrive. */
  iterable: AsyncIterable<T>;
}

/**
 * A push based, bounded-buffer async channel: `push`/`finish`/`fail`
 * drive it from a producer that runs independently of whether anyone is
 * pulling from `iterable`. Buffer size, not "has anyone started
 * iterating yet", is what caps memory, since the producer can outrace
 * the caller starting iteration.
 *
 * Generic over the item type on purpose: `buildStreamResult` is the only
 * caller today, but nothing here depends on `StreamChunk`.
 */
export function createBackpressureChannel<T>(
  options: BackpressureChannelOptions,
): BackpressureChannel<T> {
  const { capacity, logger, label } = options;

  const buffered: T[] = [];
  const pending: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  let done = false;
  let failed = false;
  let failure: unknown;
  let hasLoggedEviction = false;

  function push(value: T): void {
    const waiter = pending.shift();

    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }

    buffered.push(value);

    if (buffered.length > capacity * 2) {
      // Nothing else surfaces this: without a log, a caller that never
      // read (or fell behind on) `iterable` has no way to tell eviction,
      // not a producer bug, is why items are missing. Logged once, not
      // on every crossing, so an ignored high-volume channel doesn't
      // spam dozens of near-identical lines.
      if (!hasLoggedEviction) {
        hasLoggedEviction = true;
        logger.warn(
          `[VernLLM] ${label} buffer exceeded cap (${capacity}), evicting ` +
            `${buffered.length - capacity} oldest item(s); buffered=${buffered.length}. ` +
            'The iterable was never read (or fell far behind) for this channel.',
        );
      }

      // Trim back down to the cap in one batch operation instead of
      // `shift()`ing a single element off on every push once the cap is
      // reached. A per-push `shift()` here is O(current length) in the
      // worst case, cheap for a handful of calls, but that cost is
      // paid on every push for the remainder of an ignored channel, and
      // its real-world cost isn't a stable, engine-independent
      // property: benchmarking this exact pattern at a similar backing
      // array size showed multi-second stalls for what should be
      // sub-millisecond work. Letting the array grow to twice the cap
      // before trimming amortizes the O(n) `splice` across `capacity`
      // pushes, so the average cost per push stays O(1) regardless of
      // how far past the cap the array is allowed to grow before
      // trimming.
      buffered.splice(0, buffered.length - capacity);
    }
  }

  function finish(): void {
    done = true;

    for (const waiter of pending.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  function fail(error: unknown): void {
    done = true;
    failed = true;
    failure = error;

    for (const waiter of pending.splice(0)) {
      waiter.reject(error);
    }
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (buffered.length) {
            return Promise.resolve({ done: false, value: buffered.shift() as T });
          }

          if (done) {
            return failed
              ? Promise.reject(failure)
              : Promise.resolve({ done: true, value: undefined });
          }

          return new Promise((resolve, reject) => {
            pending.push({ resolve, reject });
          });
        },
      };
    },
  };

  return { push, finish, fail, iterable };
}
