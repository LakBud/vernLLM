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
  /**
   * Delivers `value` to a waiting puller, or buffers it. Returns a promise
   * when a consumer is reading and the buffer is full; the producer should
   * await it before pushing more. Returns `undefined` otherwise.
   */
  push(value: T): Promise<void> | undefined;
  /** Marks the channel done. Every future pull resolves `{ done: true }`. */
  finish(): void;
  /** Marks the channel failed. Every future pull rejects with `error`. */
  fail(error: unknown): void;
  /** Consumed by callers to pull values as they arrive. */
  iterable: AsyncIterable<T>;
}

const DETACH = Symbol('vern-llm-channel-detach');

type DetachableIterable<T> = AsyncIterable<T> & { [DETACH]?: () => void };

/**
 * Detaches a channel's consumer, the same as its iterator's `return()`: the
 * producer stops waiting on this reader and buffered items are kept. For a
 * wrapper whose own early exit doesn't reach the channel's `return()`, so an
 * abandoned reader can't stall the producer. A no op for any iterable a
 * channel didn't create.
 */
export function detachChunks<T>(iterable: AsyncIterable<T>): void {
  (iterable as DetachableIterable<T>)[DETACH]?.();
}

/**
 * A push based, bounded-buffer async channel: `push`/`finish`/`fail`
 * drive it from a producer that runs independently of whether anyone is
 * pulling from `iterable`. Buffer size, not "has anyone started
 * iterating yet", is what caps memory, since the producer can outrace
 * the caller starting iteration.
 *
 * Once a consumer starts reading, a full buffer holds the producer back
 * instead of evicting, so a slow reader never loses items. Eviction only
 * applies while nobody has started reading, so an ignored channel can't
 * stall the producer or grow without bound.
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
  // True while a consumer is pulling. A full buffer only holds the
  // producer back then; otherwise the eviction path below applies.
  let reading = false;
  let spaceWaiters: Array<() => void> = [];

  function releaseProducer(): void {
    const waiters = spaceWaiters;

    spaceWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // The consumer stopped pulling for now. Buffered items are kept, so a
  // later loop continues where this one left off, and the producer goes
  // back to evicting instead of waiting on a reader that may never return.
  function detach(): void {
    reading = false;

    for (const waiter of pending.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }

    releaseProducer();
  }

  function push(value: T): Promise<void> | undefined {
    const waiter = pending.shift();

    if (waiter) {
      waiter.resolve({ done: false, value });
      return undefined;
    }

    buffered.push(value);

    if (reading) {
      if (buffered.length < capacity) return undefined;

      return new Promise((resolve) => {
        spaceWaiters.push(resolve);
      });
    }

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
    releaseProducer();

    for (const waiter of pending.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  function fail(error: unknown): void {
    done = true;
    failed = true;
    failure = error;
    releaseProducer();

    for (const waiter of pending.splice(0)) {
      waiter.reject(error);
    }
  }

  const iterable: DetachableIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          reading = true;

          if (buffered.length) {
            const value = buffered.shift() as T;

            if (buffered.length < capacity) releaseProducer();

            return Promise.resolve({ done: false, value });
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
        // A `break` out of `for await` detaches the consumer rather than
        // cancelling the producer, since `finalResult` still settles from it.
        return(): Promise<IteratorResult<T>> {
          detach();

          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
    [DETACH]: detach,
  };

  return { push, finish, fail, iterable };
}
