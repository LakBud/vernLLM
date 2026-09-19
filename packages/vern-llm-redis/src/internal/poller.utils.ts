import { unrefTimer, type TimerHandle } from './timers.utils.js';

export interface Poller {
  /** Starts the interval. A no-op when already running, disposed, or the interval is 0 or less. */
  start(): void;
  /** Stops it. Safe to call when not running. */
  stop(): void;
}

/** A single background interval that never keeps the process alive. */
export function createPoller(
  intervalMs: number,
  tick: () => void,
  isDisposed: () => boolean,
): Poller {
  let timer: TimerHandle | undefined;

  return {
    start() {
      if (timer || isDisposed() || intervalMs <= 0) return;

      timer = setInterval(tick, intervalMs);
      unrefTimer(timer);
    },

    stop() {
      if (!timer) return;

      clearInterval(timer);
      timer = undefined;
    },
  };
}
