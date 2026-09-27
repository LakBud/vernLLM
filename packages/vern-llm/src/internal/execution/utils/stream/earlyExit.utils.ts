/**
 * Wraps `chunks` so that stopping before the end calls `onExit` once the
 * last active reader has left: a `break` out of `for await`, an exception
 * thrown in the loop body, or a direct `return()`. A reader is active from
 * its first pull until it reaches the end, its pull rejects, or it
 * returns. An early exit while another reader is still active doesn't
 * fire, since that reader still needs the stream. Reaching the end, or a
 * pull rejecting because the stream itself failed, never fires. The inner
 * iterator is closed either way.
 */
export function onEarlyExit<T>(chunks: AsyncIterable<T>, onExit: () => void): AsyncIterable<T> {
  let activeReaders = 0;

  return {
    [Symbol.asyncIterator]() {
      const iterator = chunks[Symbol.asyncIterator]();
      let active = false;
      let ended = false;

      // Runs once per reader, whichever way it ends.
      const end = (): void => {
        ended = true;
        if (active) {
          active = false;
          activeReaders--;
        }
      };

      return {
        async next(): Promise<IteratorResult<T>> {
          if (!active && !ended) {
            active = true;
            activeReaders++;
          }

          try {
            const result = await iterator.next();
            if (result.done) end();
            return result;
          } catch (error) {
            end();
            throw error;
          }
        },
        async return(): Promise<IteratorResult<T>> {
          if (!ended) {
            end();
            if (activeReaders === 0) onExit();
          }

          await iterator.return?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}
