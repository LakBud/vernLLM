import { createMemo } from '../scan/memo.utils.js';
import { segmentKey } from '../scan/spans.utils.js';
import { createLimit, type Limit } from './limit.js';

import type { Detector, Finding, Segment } from '../../types/index.js';
import type { Span } from '../scan/types.js';

/** A finding of a hosted detector: it always has a label, and offsets only when it can locate it. */
export type Hit = Span & { label: string };

/** A detector, and the same detector narrowed to some kinds of finding. */
export type HostedDetector<Kind extends string> = Detector & {
  /** Another detector over the same requests and cache, returning only these kinds. */
  only(...kinds: Kind[]): Detector;
};

export interface HostedConfig<Kind extends string> {
  /** The detector's name, for error messages. */
  name: string;
  kinds: readonly Kind[];
  /** The kind a label belongs to. */
  kindOf(label: string): string;
  concurrency: number;
  cache: false | { max: number };
  /**
   * Asks the provider about texts nobody has asked about yet. One list of hits per segment, in
   * order. Network calls go through `limit`, and stop when `signal` aborts.
   */
  analyze(segments: readonly Segment[], signal: AbortSignal, limit: Limit): Promise<Hit[][]>;
}

/** One request to the provider, shared by every call that needs one of its texts. */
interface Flight {
  controller: AbortController;
  keys: string[];
  /** Calls still waiting for it. When the last one gives up, the request is aborted. */
  waiters: number;
  /** Whether it has finished, one way or the other, and is no longer worth aborting. */
  settled: boolean;
  answer: Promise<Hit[][]>;
}

/**
 * The part every hosted detector shares: views by kind, one request per text however many views
 * ask, a cache of labels and offsets (never text), and a limit on requests in flight. What a
 * provider answers lives in `analyze`.
 */
export function createHosted<Kind extends string>(
  config: HostedConfig<Kind>,
): HostedDetector<Kind> {
  const { name, kinds, kindOf, analyze } = config;
  const cache = config.cache === false ? undefined : createMemo(config.cache.max);
  const limit = createLimit(config.concurrency);
  const flights = new Map<string, { flight: Flight; index: number }>();

  function start(fresh: readonly { key: string; segment: Segment }[]): Flight {
    const flight = {
      controller: new AbortController(),
      keys: fresh.map((entry) => entry.key),
      waiters: 0,
      settled: false,
    } as Flight;
    fresh.forEach(({ key }, index) => flights.set(key, { flight, index }));

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
        fresh.forEach(({ key }, index) => cache?.set(key, hits[index]!));
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
  }

  /** Forgets a flight, so a later call starts its own instead of joining one that is over. */
  function drop(flight: Flight): void {
    for (const key of flight.keys) {
      if (flights.get(key)?.flight === flight) flights.delete(key);
    }
  }

  async function lookup(
    segments: readonly Segment[],
    signal: AbortSignal,
  ): Promise<(readonly Span[])[]> {
    const keys = segments.map(segmentKey);
    const known = new Map<string, readonly Span[]>();
    const joined = new Map<string, { flight: Flight; index: number }>();
    const fresh: { key: string; segment: Segment }[] = [];
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

    // A call that has stopped asks for nothing. What is already remembered still answers it.
    if (fresh.length + joined.size > 0) signal.throwIfAborted();

    if (fresh.length > 0) {
      const flight = start(fresh);
      fresh.forEach(({ key }, index) => joined.set(key, { flight, index }));
    }

    const waitingOn = new Set([...joined.values()].map((entry) => entry.flight));
    for (const flight of waitingOn) flight.waiters += 1;

    // The last call to stop waiting aborts the request with its own reason, and nobody new can
    // join it.
    let released = false;
    const release = (reason?: unknown): void => {
      if (released) return;
      released = true;
      for (const flight of waitingOn) {
        flight.waiters -= 1;
        if (flight.waiters === 0) {
          drop(flight);
          if (!flight.settled) flight.controller.abort(reason);
        }
      }
    };
    const onAbort = (): void => release(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const answers = new Map<Flight, Hit[][]>();
      await Promise.all(
        [...waitingOn].map(async (flight) => answers.set(flight, await flight.answer)),
      );
      return keys.map((key) => {
        const entry = joined.get(key);
        return known.get(key) ?? answers.get(entry!.flight)![entry!.index]!;
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
      release();
    }
  }

  function view(wanted?: ReadonlySet<string>): Detector {
    return async (segments, signal): Promise<Finding[]> => {
      const found = await lookup(segments, signal);
      return found.flatMap((spans, segment) =>
        spans
          .filter((span) => wanted === undefined || wanted.has(kindOf(span.label!)))
          .map((span) => ({ segment, ...span })),
      );
    };
  }

  return Object.assign(view(), {
    only(...wanted: Kind[]): Detector {
      if (wanted.length === 0) throw new TypeError(`${name}: only() needs at least one kind`);
      for (const kind of wanted) {
        if (!kinds.includes(kind)) throw new TypeError(`${name}: unknown kind "${kind}"`);
      }
      return view(new Set<string>(wanted));
    },
  });
}
