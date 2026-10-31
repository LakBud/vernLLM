import {
  createFlights,
  type Flight,
  type FlightEntry,
  type Flights,
  type FreshText,
} from './flights.js';
import { createLimit } from './limit.js';
import { createMemo, segmentKey } from './memo.js';

import type { Segment } from '../types.js';
import type { Analyze, Hit, Memo, Span } from './types.js';

/** Answers with the findings for each segment, in order, asking the provider only about new texts. */
export type Lookup = (
  segments: readonly Segment[],
  signal: AbortSignal,
) => Promise<(readonly Span[])[]>;

export interface LookupConfig {
  name: string;
  analyze: Analyze;
  concurrency: number;
  cache: false | { max: number };
}

/**
 * Counts a call as a waiter on each flight. The last call to stop waiting aborts the request with
 * its own reason, and nobody new can join it. A call that is aborted stops at once with its own
 * reason, even when other calls keep the requests it shared going.
 */
function follow(flights: Flights, waitingOn: ReadonlySet<Flight>, signal: AbortSignal) {
  for (const flight of waitingOn) flight.waiters += 1;

  let released = false;
  const release = (reason?: unknown): void => {
    if (released) return;
    released = true;
    for (const flight of waitingOn) {
      flight.waiters -= 1;
      if (flight.waiters === 0) {
        flights.drop(flight);
        if (!flight.settled) flight.controller.abort(reason);
      }
    }
  };

  let stop!: (reason: unknown) => void;
  const stopped = new Promise<never>((_resolve, reject) => (stop = reject));
  const onAbort = (): void => {
    release(signal.reason);
    stop(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  return {
    /** Rejects with the call's own reason as soon as it is aborted. */
    stopped,
    /** Stops listening and gives up the flights this call no longer needs. */
    done: (): void => {
      signal.removeEventListener('abort', onAbort);
      release();
    },
  };
}

/**
 * Reads what is remembered or already in flight, and asks the provider about the rest. One request
 * per text however many calls need it, and a request is given up when its last waiter stops.
 */
export function createLookup(config: LookupConfig): Lookup {
  const { name, analyze, concurrency } = config;
  const cache: Memo | undefined = config.cache === false ? undefined : createMemo(config.cache.max);
  const remember = cache && ((key: string, hits: readonly Span[]): void => cache.set(key, hits));
  const flights = createFlights(name, analyze, createLimit(concurrency), remember);

  /** Sorts each distinct text into remembered, in flight, or new. */
  const sort = (keys: readonly string[], segments: readonly Segment[]) => {
    const known = new Map<string, readonly Span[]>();
    const joined = new Map<string, FlightEntry>();
    const fresh: FreshText[] = [];
    const seen = new Set<string>();

    keys.forEach((key, position) => {
      if (seen.has(key)) return;
      seen.add(key);

      const cached = cache?.get(key);
      const flying = flights.get(key);
      if (cached) known.set(key, cached);
      else if (flying) joined.set(key, flying);
      else fresh.push({ key, segment: segments[position]! });
    });

    return { known, joined, fresh };
  };

  return async (segments, signal) => {
    const keys = await Promise.all(segments.map(({ source, text }) => segmentKey(source, text)));
    const { known, joined, fresh } = sort(keys, segments);

    // A call that has stopped asks for nothing. What is already remembered still answers it.
    if (fresh.length + joined.size > 0) signal.throwIfAborted();

    if (fresh.length > 0) {
      const flight = flights.start(fresh);
      fresh.forEach(({ key }, index) => joined.set(key, { flight, index }));
    }

    const waitingOn = new Set([...joined.values()].map((entry) => entry.flight));
    const waiting = follow(flights, waitingOn, signal);

    try {
      const answers = new Map<Flight, Hit[][]>();
      await Promise.race([
        waiting.stopped,
        Promise.all([...waitingOn].map(async (flight) => answers.set(flight, await flight.answer))),
      ]);
      return keys.map((key) => {
        const entry = joined.get(key);
        return known.get(key) ?? answers.get(entry!.flight)![entry!.index]!;
      });
    } finally {
      waiting.done();
    }
  };
}
