import { describe, expect, it, vi } from 'vitest';

import { createHosted, type Hit } from '../../../../src/internal/hosted/instance.js';
import { createLimit, type Limit } from '../../../../src/internal/hosted/limit.js';

import type { Segment } from '../../../../src/index.js';

const user = (text: string): Segment => ({ text, source: 'user' });
const tool = (text: string): Segment => ({ text, source: 'tool' });
const later = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Analyze = (
  segments: readonly Segment[],
  signal: AbortSignal,
  limit: Limit,
) => Promise<Hit[][]>;

/** Finds `kind.a` in a text with an `a` and `kind.b` in one with a `b`, and records every request. */
function instance(
  overrides: { analyze?: Analyze; cache?: false | { max: number }; concurrency?: number } = {},
) {
  const requests: string[][] = [];
  const analyze: Analyze =
    overrides.analyze ??
    (async (segments) => {
      requests.push(segments.map((segment) => segment.text));
      return segments.map((segment) => [
        ...(segment.text.includes('a') ? [{ label: 'kind.a' }] : []),
        ...(segment.text.includes('b') ? [{ label: 'kind.b', start: 0, end: 1 }] : []),
      ]);
    });
  const spy = vi.fn(analyze);
  const detect = createHosted<'a' | 'b'>({
    name: 'test',
    kinds: ['a', 'b'],
    kindOf: (label) => label.slice('kind.'.length),
    concurrency: overrides.concurrency ?? 4,
    cache: overrides.cache ?? { max: 100 },
    analyze: spy,
  });
  return { detect, spy, requests, signal: new AbortController().signal };
}

describe('createHosted', () => {
  describe('findings and views', () => {
    it('returns every kind of finding, numbered by segment, with offsets when it has them', async () => {
      const { detect, signal } = instance();

      expect(await detect([user('xa'), user('x'), user('ab')], signal)).toEqual([
        { segment: 0, label: 'kind.a' },
        { segment: 2, label: 'kind.a' },
        { segment: 2, label: 'kind.b', start: 0, end: 1 },
      ]);
    });

    it('narrows to some kinds with only()', async () => {
      const { detect, signal } = instance();

      expect(await detect.only('b')([user('ab')], signal)).toEqual([
        { segment: 0, label: 'kind.b', start: 0, end: 1 },
      ]);
      expect(await detect.only('a', 'b')([user('ab')], signal)).toHaveLength(2);
    });

    it('refuses a view of no kinds or of an unknown one', () => {
      const { detect } = instance();

      expect(() => detect.only()).toThrow('test: only() needs at least one kind');
      expect(() => detect.only('c' as never)).toThrow('test: unknown kind "c"');
    });

    it('answers nothing for no segments, without asking the provider', async () => {
      const { detect, spy, signal } = instance();

      expect(await detect([], signal)).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('one request per text', () => {
    it('asks once for a text however many views read it', async () => {
      const { detect, requests, signal } = instance();

      await detect.only('a')([user('ab')], signal);
      await detect.only('b')([user('ab')], signal);
      await detect([user('ab')], signal);

      expect(requests).toEqual([['ab']]);
    });

    it('lets views that ask at the same moment share one request', async () => {
      const { detect, spy, signal } = instance({
        analyze: async (segments) => {
          await later(10);
          return segments.map(() => [{ label: 'kind.a' }]);
        },
      });

      const [first, second] = await Promise.all([
        detect.only('a')([user('x')], signal),
        detect.only('b')([user('x')], signal),
      ]);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);
    });

    it('asks together for the texts that are new, and not for the ones it knows', async () => {
      const { detect, requests, signal } = instance();

      await detect([user('a')], signal);
      await detect([user('a'), user('b'), user('c')], signal);

      expect(requests).toEqual([['a'], ['b', 'c']]);
    });

    it('asks once for a text that is in a call twice, and answers for both places', async () => {
      const { detect, requests, signal } = instance();

      expect(await detect([user('a'), user('a')], signal)).toEqual([
        { segment: 0, label: 'kind.a' },
        { segment: 1, label: 'kind.a' },
      ]);
      expect(requests).toEqual([['a']]);
    });

    it('keeps a text from one source apart from the same text from another', async () => {
      const { detect, requests, signal } = instance();

      await detect([user('a'), tool('a')], signal);

      expect(requests).toEqual([['a', 'a']]);
    });

    it('remembers a text with nothing found as well as one with findings', async () => {
      const { detect, requests, signal } = instance();

      await detect([user('x')], signal);
      expect(await detect([user('x')], signal)).toEqual([]);

      expect(requests).toEqual([['x']]);
    });

    it('does not remember anything with cache off, but still shares a request in flight', async () => {
      const { detect, spy, signal } = instance({
        cache: false,
        analyze: async (segments) => {
          await later(10);
          return segments.map(() => []);
        },
      });

      await Promise.all([detect([user('x')], signal), detect([user('x')], signal)]);
      expect(spy).toHaveBeenCalledTimes(1);

      await detect([user('x')], signal);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('forgets the least recently used text past its size', async () => {
      const { detect, requests, signal } = instance({ cache: { max: 1 } });

      await detect([user('a')], signal);
      await detect([user('b')], signal);
      await detect([user('a')], signal);

      expect(requests).toEqual([['a'], ['b'], ['a']]);
    });
  });

  describe('when the provider fails', () => {
    it('throws what it threw, and remembers nothing, so the next call asks again', async () => {
      const failure = new Error('down');
      let fail = true;
      const { detect, spy, signal } = instance({
        analyze: async (segments) => {
          if (fail) throw failure;
          return segments.map(() => []);
        },
      });

      await expect(detect([user('x')], signal)).rejects.toBe(failure);
      fail = false;
      expect(await detect([user('x')], signal)).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('fails every call that was waiting on the same request', async () => {
      const failure = new Error('down');
      const { detect, signal } = instance({
        analyze: async () => {
          await later(5);
          throw failure;
        },
      });

      const results = await Promise.allSettled([
        detect([user('x')], signal),
        detect.only('a')([user('x')], signal),
      ]);

      expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    });

    it('throws when the answer is not one list per text', async () => {
      const { detect, signal } = instance({ analyze: async () => [] });

      await expect(detect([user('x')], signal)).rejects.toThrow(
        'test: the provider answered for the wrong number of texts',
      );
      const notAList = instance({ analyze: async () => undefined as never });
      await expect(notAList.detect([user('x')], notAList.signal)).rejects.toThrow(/wrong number/);
    });
  });

  describe('stopping', () => {
    /** Answers late, and rejects when its signal aborts. */
    function slow() {
      const signals: AbortSignal[] = [];
      const analyze: Analyze = (segments, signal) => {
        signals.push(signal);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(segments.map(() => [{ label: 'kind.a' }])), 30);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason);
          });
        });
      };
      return { analyze, signals };
    }

    it('aborts the request when the only call waiting on it stops', async () => {
      const { analyze, signals } = slow();
      const { detect } = instance({ analyze });
      const controller = new AbortController();

      const pending = detect([user('x')], controller.signal);
      await later(1);
      controller.abort(new Error('timed out'));

      await expect(pending).rejects.toThrow('timed out');
      expect(signals[0]!.aborted).toBe(true);
    });

    it('keeps a shared request going while a call still waits for it', async () => {
      const { analyze, signals } = slow();
      const { detect } = instance({ analyze });
      const first = new AbortController();
      const second = new AbortController();

      const stopped = detect([user('x')], first.signal);
      const waiting = detect.only('a')([user('x')], second.signal);
      first.abort(new Error('timed out'));

      // The first call is only given up on by its caller. The request is still wanted.
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(false);
      expect(await waiting).toHaveLength(1);
      expect(await stopped).toHaveLength(1);
    });

    it('aborts a shared request once every call waiting on it has stopped', async () => {
      const { analyze, signals } = slow();
      const { detect } = instance({ analyze });
      const first = new AbortController();
      const second = new AbortController();

      const one = detect([user('x')], first.signal);
      const two = detect([user('x')], second.signal);
      first.abort(new Error('one'));
      second.abort(new Error('two'));

      await expect(Promise.all([one, two])).rejects.toThrow();
      expect(signals[0]!.aborted).toBe(true);
    });

    it('starts a new request for a text whose request was aborted', async () => {
      const { analyze, signals } = slow();
      const { detect, signal } = instance({ analyze });
      const controller = new AbortController();

      const pending = detect([user('x')], controller.signal);
      controller.abort(new Error('timed out'));
      await expect(pending).rejects.toThrow('timed out');

      expect(await detect([user('x')], signal)).toHaveLength(1);
      expect(signals).toHaveLength(2);
      expect(signals[1]!.aborted).toBe(false);
    });

    it('does not abort a request that finished, when its last call is done with it', async () => {
      const { analyze, signals } = slow();
      const { detect, signal } = instance({ analyze });

      await detect([user('x')], signal);

      expect(signals[0]!.aborted).toBe(false);
    });

    it('asks for nothing on behalf of a call that has already stopped', async () => {
      const { analyze, signals } = slow();
      const { detect } = instance({ analyze });
      const controller = new AbortController();
      controller.abort(new Error('already'));

      await expect(detect([user('x')], controller.signal)).rejects.toThrow('already');
      expect(signals).toHaveLength(0);
    });

    it('does not let a call that has already stopped join a request in flight', async () => {
      const { analyze, signals } = slow();
      const { detect, signal } = instance({ analyze });
      const running = detect([user('x')], signal);

      const stopped = new AbortController();
      stopped.abort(new Error('already'));
      await expect(detect([user('x')], stopped.signal)).rejects.toThrow('already');

      // The call that is still waiting is not affected.
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(false);
      expect(await running).toHaveLength(1);
    });

    it('answers a stopped call from what is remembered, with no request', async () => {
      const { detect, spy, signal } = instance();
      await detect([user('a')], signal);

      const controller = new AbortController();
      controller.abort();

      expect(await detect([user('a')], controller.signal)).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it('hands the provider the limit that every view shares', async () => {
    const limits = new Set<Limit>();
    const { detect, signal } = instance({
      analyze: async (segments, _signal, limit) => {
        limits.add(limit);
        return segments.map(() => []);
      },
    });

    await detect([user('a')], signal);
    await detect.only('a')([user('b')], signal);

    expect(limits.size).toBe(1);
  });
});

describe('createLimit', () => {
  it('runs at most max tasks at once, and all of them', async () => {
    const limit = createLimit(2);
    let active = 0;
    let peak = 0;
    const finished: number[] = [];

    await Promise.all(
      [1, 2, 3, 4, 5].map((id) =>
        limit(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await later(5);
          active -= 1;
          finished.push(id);
        }),
      ),
    );

    expect(peak).toBe(2);
    expect(finished.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('starts waiting tasks in the order they came', async () => {
    const limit = createLimit(1);
    const started: number[] = [];

    await Promise.all(
      [1, 2, 3].map((id) =>
        limit(async () => {
          started.push(id);
          await later(2);
        }),
      ),
    );

    expect(started).toEqual([1, 2, 3]);
  });

  it('does not let a new task jump a slot that is passing to a waiting one', async () => {
    const limit = createLimit(1);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await later(2);
      active -= 1;
    };

    const first = limit(task);
    const second = limit(task);
    await first;
    // The slot is now the second task's. A task arriving in this turn must wait behind it.
    const third = limit(task);
    await Promise.all([second, third]);

    expect(peak).toBe(1);
  });

  it('frees its slot when a task throws, and passes the error on', async () => {
    const limit = createLimit(1);

    await expect(
      limit(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await limit(async () => 'next')).toBe('next');
  });
});
