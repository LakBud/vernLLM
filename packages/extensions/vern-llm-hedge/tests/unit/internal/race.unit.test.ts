import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { firstSuccess, raceDelay } from '../../../src/internal/race.utils.js';

import type { CallResult } from 'vern-llm';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const result = (value: string): CallResult => ({ value });

describe('raceDelay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('elapses when main is still pending after the delay', async () => {
    const main = deferred<CallResult>();
    const raced = raceDelay(main.promise, 100, undefined);

    await vi.advanceTimersByTimeAsync(100);

    await expect(raced).resolves.toBe('elapsed');
  });

  it('settles when main answers first, and clears its timer', async () => {
    const main = deferred<CallResult>();
    const raced = raceDelay(main.promise, 100, undefined);

    main.resolve(result('a'));

    await expect(raced).resolves.toBe('settled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles when main fails first, since its own error is the outcome', async () => {
    const main = deferred<CallResult>();
    const raced = raceDelay(main.promise, 100, undefined);

    main.reject(new Error('boom'));

    await expect(raced).resolves.toBe('settled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles at once for a signal that is already aborted, with no timer', async () => {
    const raced = raceDelay(new Promise(() => {}), 100, AbortSignal.abort());

    await expect(raced).resolves.toBe('settled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles when the signal aborts during the wait, and clears its timer', async () => {
    const controller = new AbortController();
    const raced = raceDelay(new Promise(() => {}), 100, controller.signal);

    controller.abort();

    await expect(raced).resolves.toBe('settled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops listening to the signal once it has settled', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const raced = raceDelay(Promise.resolve(result('a')), 100, controller.signal);

    await raced;

    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('does not fire at once for a delay beyond the longest timer', async () => {
    const raced = vi.fn();
    void raceDelay(new Promise(() => {}), 10 ** 12, undefined).then(raced);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(raced).not.toHaveBeenCalled();
  });
});

describe('firstSuccess', () => {
  it('returns main when it answers first', async () => {
    const main = deferred<CallResult>();
    const hedge = deferred<CallResult>();
    const raced = firstSuccess([main.promise, hedge.promise]);

    const answer = result('main');
    main.resolve(answer);

    const { result: kept, winner } = await raced;
    expect(kept).toBe(answer);
    expect(winner).toBe(0);
  });

  it('returns the hedge when it answers first, as the exact object it produced', async () => {
    const main = deferred<CallResult>();
    const hedge = deferred<CallResult>();
    const raced = firstSuccess([main.promise, hedge.promise]);

    const answer = result('hedge');
    hedge.resolve(answer);

    const { result: kept, winner } = await raced;
    expect(kept).toBe(answer);
    expect(winner).toBe(1);
  });

  it('keeps main when both have already answered', async () => {
    const { winner } = await firstSuccess([
      Promise.resolve(result('main')),
      Promise.resolve(result('hedge')),
    ]);

    expect(winner).toBe(0);
  });

  it('keeps the hedge when main fails first, since it works as an extra fallback', async () => {
    const main = deferred<CallResult>();
    const hedge = deferred<CallResult>();
    const raced = firstSuccess([main.promise, hedge.promise]);

    main.reject(new Error('main failed'));
    hedge.resolve(result('hedge'));

    await expect(raced).resolves.toMatchObject({ winner: 1 });
  });

  it('keeps main when the hedge fails first', async () => {
    const main = deferred<CallResult>();
    const hedge = deferred<CallResult>();
    const raced = firstSuccess([main.promise, hedge.promise]);

    hedge.reject(new Error('hedge failed'));
    main.resolve(result('main'));

    await expect(raced).resolves.toMatchObject({ winner: 0 });
  });

  it('throws the main error when both fail, whichever failed first', async () => {
    const main = deferred<CallResult>();
    const hedge = deferred<CallResult>();
    const raced = firstSuccess([main.promise, hedge.promise]);
    const mainError = new Error('main failed');

    hedge.reject(new Error('hedge failed'));
    main.reject(mainError);

    await expect(raced).rejects.toBe(mainError);
  });

  it('stays pending while one chain has failed and the other has not settled', async () => {
    const main = deferred<CallResult>();
    const settled = vi.fn();
    void firstSuccess([main.promise, Promise.reject(new Error('hedge failed'))]).then(
      settled,
      settled,
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();
  });
});

describe('firstSuccess with several hedges', () => {
  it('keeps the first of three to answer, by its index', async () => {
    const [a, b, c] = [deferred<CallResult>(), deferred<CallResult>(), deferred<CallResult>()];
    const raced = firstSuccess([a.promise, b.promise, c.promise]);

    c.resolve(result('c'));

    await expect(raced).resolves.toMatchObject({ winner: 2 });
  });

  it('keeps the lowest index when several have already answered', async () => {
    const { winner } = await firstSuccess([
      Promise.reject(new Error('main failed')),
      Promise.resolve(result('one')),
      Promise.resolve(result('two')),
    ]);

    expect(winner).toBe(1);
  });

  it('throws the main error only when every chain has failed', async () => {
    const [a, b, c] = [deferred<CallResult>(), deferred<CallResult>(), deferred<CallResult>()];
    const mainError = new Error('main failed');
    const raced = firstSuccess([a.promise, b.promise, c.promise]);

    c.reject(new Error('c'));
    b.reject(new Error('b'));
    a.reject(mainError);

    await expect(raced).rejects.toBe(mainError);
  });
});
