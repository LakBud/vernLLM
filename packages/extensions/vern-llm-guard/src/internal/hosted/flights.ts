import type { Segment } from '../../types/index.js';
import type { Limit } from './limit.js';
import type { Analyze, Hit } from './types.js';

/** One request to the provider, shared by every call that needs one of its texts. */
export interface Flight {
  controller: AbortController;
  keys: string[];
  /** Calls still waiting for it. When the last one gives up, the request is aborted. */
  waiters: number;
  /** Whether it has finished, one way or the other, and is no longer worth aborting. */
  settled: boolean;
  answer: Promise<Hit[][]>;
}

/** Where one text's answer sits in a flight. */
export interface FlightEntry {
  flight: Flight;
  index: number;
}

/** A text nobody has asked about yet, and the key it is remembered by. */
export interface FreshText {
  key: string;
  segment: Segment;
}

export interface Flights {
  get(key: string): FlightEntry | undefined;
  start(fresh: readonly FreshText[]): Flight;
  drop(flight: Flight): void;
}

/**
 * The requests in flight, one per text however many calls need it. Remembers each answer through
 * `remember`, and forgets a request as soon as it settles or is no longer wanted.
 */
export function createFlights(
  name: string,
  analyze: Analyze,
  limit: Limit,
  remember: ((key: string, hits: Hit[]) => void) | undefined,
): Flights {
  const entries = new Map<string, FlightEntry>();

  /** Forgets a flight, so a later call starts its own instead of joining one that is over. */
  const drop = (flight: Flight): void => {
    for (const key of flight.keys) {
      if (entries.get(key)?.flight === flight) entries.delete(key);
    }
  };

  const start = (fresh: readonly FreshText[]): Flight => {
    const flight = {
      controller: new AbortController(),
      keys: fresh.map((entry) => entry.key),
      waiters: 0,
      settled: false,
    } as Flight;
    fresh.forEach(({ key }, index) => entries.set(key, { flight, index }));

    flight.answer = (async () => {
      try {
        const hits = await analyze(
          fresh.map((entry) => entry.segment),
          flight.controller.signal,
          limit,
        );
        if (!Array.isArray(hits) || hits.length !== fresh.length) {
          throw new Error(`${name}: the provider answered for the wrong number of texts`);
        }
        fresh.forEach(({ key }, index) => remember?.(key, hits[index]!));
        return hits;
      } catch (error) {
        // Stop the batches still queued or in flight
        flight.controller.abort(error);
        throw error;
      } finally {
        flight.settled = true;
        drop(flight);
      }
    })();
    // The calls waiting on it see the failure. This keeps one nobody waits on from going unhandled.
    flight.answer.catch(() => {});
    return flight;
  };

  return { get: (key) => entries.get(key), start, drop };
}
