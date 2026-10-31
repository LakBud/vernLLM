import type { Segment } from '../types.js';
import type { Analyze, Hit, Limit } from './types.js';

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

  /** Asks the provider about the texts and remembers what it answers. A failure stops the rest. */
  const ask = async (
    fresh: readonly FreshText[],
    controller: AbortController,
  ): Promise<Hit[][]> => {
    try {
      const hits = await analyze(
        fresh.map((entry) => entry.segment),
        controller.signal,
        limit,
      );
      if (!Array.isArray(hits) || hits.length !== fresh.length) {
        throw new Error(`${name}: the provider answered for the wrong number of texts`);
      }
      fresh.forEach(({ key }, index) => remember?.(key, hits[index]!));
      return hits;
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };

  const start = (fresh: readonly FreshText[]): Flight => {
    const controller = new AbortController();
    const flight: Flight = {
      controller,
      keys: fresh.map((entry) => entry.key),
      waiters: 0,
      settled: false,
      answer: ask(fresh, controller),
    };
    fresh.forEach(({ key }, index) => entries.set(key, { flight, index }));

    // Once over, the flight is forgotten. The calls waiting on it see any failure, and handling it
    // here keeps a flight nobody waits on from going unhandled.
    const finish = (): void => {
      flight.settled = true;
      drop(flight);
    };
    flight.answer.then(finish, finish);
    return flight;
  };

  return { get: (key) => entries.get(key), start, drop };
}
