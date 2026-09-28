import { unrefTimer, type TimerHandle } from './timers.utils.js';

/** Renewals an adapter runs while calls hold something in Redis. */
export interface Heartbeats {
  /** Runs `beat` every `intervalMs` until stopped. Never keeps the process alive. */
  start(beat: () => void, intervalMs: number): () => void;
  /** Stops every heartbeat. */
  stopAll(): void;
}

export function createHeartbeats(): Heartbeats {
  const timers = new Set<TimerHandle>();

  return {
    start(beat, intervalMs) {
      const timer = setInterval(beat, intervalMs);
      unrefTimer(timer);
      timers.add(timer);

      return () => {
        clearInterval(timer);
        timers.delete(timer);
      };
    },

    stopAll() {
      for (const timer of timers) clearInterval(timer);
      timers.clear();
    },
  };
}

/** About a third of `leaseMs`, so two lost beats still don't lapse it. */
export function renewalInterval(leaseMs: number): number {
  return Math.max(1, Math.floor(leaseMs / 3));
}
