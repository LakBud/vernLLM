/**
 * Wraps `chunks` so a reader that stops before the end calls
 * `onEarlyExit` once: a `break` out of `for await`, an exception thrown
 * in the loop body, or a direct `return()`. A reader that reached the end,
 * or whose pull rejected because the stream itself failed, doesn't, since
 * there is nothing left to stop. The inner iterator is still closed
 * either way.
 */
export function onEarlyExit<T>(chunks: AsyncIterable<T>, onExit: () => void): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = chunks[Symbol.asyncIterator]();
      let ended = false;

      return {
        async next(): Promise<IteratorResult<T>> {
          try {
            const result = await iterator.next();
            if (result.done) ended = true;
            return result;
          } catch (error) {
            ended = true;
            throw error;
          }
        },
        async return(): Promise<IteratorResult<T>> {
          if (!ended) {
            ended = true;
            onExit();
          }

          await iterator.return?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}
