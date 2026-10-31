import type { Limit } from './types.js';

/** At most `max` tasks run at once. A freed slot goes straight to the oldest waiting task. */
export function createLimit(max: number): Limit {
  let active = 0;
  const waiting: (() => void)[] = [];

  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  return async (task) => {
    if (active < max) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));

    try {
      return await task();
    } finally {
      release();
    }
  };
}
