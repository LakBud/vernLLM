import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  memoryUsageStore as createStore,
  type Amount,
  type MemoryUsageStoreOptions,
  type Scope,
} from '../../../src/index.js';

type Held = { spent: Amount; reserved: Amount };

/** The memory store answers synchronously, which the public `UsageStore` type does not promise. */
function memoryUsageStore(options?: MemoryUsageStoreOptions) {
  const store = createStore(options);
  return {
    reserve: store.reserve as (
      ...args: Parameters<typeof store.reserve>
    ) => Awaited<ReturnType<typeof store.reserve>>,
    commit: store.commit,
    release: store.release,
    read: store.read as (scope: Scope) => Held,
  };
}

const scope = (
  key: string,
  limit: number,
  unit: Scope['unit'] = 'tokens',
  resetsAtMs = Date.now() + 1000,
): Scope => ({
  key,
  label: key,
  unit,
  limit,
  mode: 'hard',
  resetsAtMs,
});
const amount = (tokens: number, nanoUsd = 0) => ({ tokens, nanoUsd });

afterEach(() => {
  vi.useRealTimers();
});

describe('memoryUsageStore', () => {
  it('holds an amount, then replaces it with the real spend on commit', () => {
    const store = memoryUsageStore();
    const s = scope('a', 100);

    const outcome = store.reserve([s], amount(60), 1000) as { ok: true; id: string };
    expect(store.read(s)).toEqual({ spent: amount(0), reserved: amount(60) });

    store.commit(outcome.id, amount(25));
    expect(store.read(s)).toEqual({ spent: amount(25), reserved: amount(0) });
  });

  it('denies with what is left, and counts reservations like spend', () => {
    const store = memoryUsageStore();
    const s = scope('a', 100);
    store.reserve([s], amount(70), 1000);

    expect(store.reserve([s], amount(40), 1000)).toEqual({ ok: false, scope: s, remaining: 30 });
  });

  it('limits dollars and tokens separately, by the scope unit', () => {
    const store = memoryUsageStore();
    const usd = scope('usd', 100, 'usd');

    expect(store.reserve([usd], amount(1_000_000, 90), 1000)).toMatchObject({ ok: true });
    expect(store.reserve([usd], amount(0, 20), 1000)).toMatchObject({ ok: false, remaining: 10 });
  });

  it('holds nothing anywhere when any scope is full', () => {
    const store = memoryUsageStore();
    const roomy = scope('roomy', 100);
    const full = scope('full', 10);

    expect(store.reserve([roomy, full], amount(50), 1000)).toMatchObject({
      ok: false,
      scope: full,
    });
    expect(store.read(roomy).reserved).toEqual(amount(0));
  });

  it('frees a reservation on release, and ignores unknown or repeated ids', () => {
    const store = memoryUsageStore();
    const s = scope('a', 100);
    const { id } = store.reserve([s], amount(60), 1000) as { ok: true; id: string };

    store.release(id);
    store.release(id);
    store.commit('nope', amount(5));

    expect(store.read(s)).toEqual({ spent: amount(0), reserved: amount(0) });
  });

  it('still records the spend of a commit that arrives after its hold expired', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = memoryUsageStore();
    const s = scope('a', 100, 'tokens', Date.now() + 10_000_000);
    const { id } = store.reserve([s], amount(60), 1000) as { ok: true; id: string };

    vi.setSystemTime(Date.now() + 1500);
    expect(store.reserve([s], amount(30), 1000)).toMatchObject({ ok: true });
    // The expired hold stopped holding room, but what the call really spent still counts.
    expect(store.read(s)).toEqual({ spent: amount(0), reserved: amount(30) });
    store.commit(id, amount(60));

    expect(store.read(s).spent).toEqual(amount(60));
    // Settled once: a repeated commit adds nothing.
    store.commit(id, amount(60));
    expect(store.read(s).spent).toEqual(amount(60));
  });

  it('forgets an expired hold after a while, so its late spend has nowhere to go', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = memoryUsageStore();
    const s = scope('a', 100, 'tokens', Date.now() + 100_000_000);
    const { id } = store.reserve([s], amount(60), 1000) as { ok: true; id: string };

    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    store.read(s);
    store.commit(id, amount(60));

    expect(store.read(s).spent).toEqual(amount(0));
  });

  it('frees expired holds when read, not only when reserved', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = memoryUsageStore();
    const s = scope('a', 100, 'tokens', Date.now() + 10_000_000);
    store.reserve([s], amount(60), 1000);

    vi.setSystemTime(Date.now() + 1500);

    expect(store.read(s).reserved).toEqual(amount(0));
  });

  it('returns zeros for a scope never used, and copies rather than live state', () => {
    const store = memoryUsageStore();
    const s = scope('a', 100);
    expect(store.read(s)).toEqual({ spent: amount(0), reserved: amount(0) });

    store.reserve([s], amount(10), 1000);
    const view = store.read(s);
    view.reserved.tokens = 999;
    expect(store.read(s).reserved.tokens).toBe(10);
  });

  it('sweeps finished idle windows so memory does not grow', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const warnings: string[] = [];
    const store = memoryUsageStore({ maxScopes: 2, onWarning: (m) => warnings.push(m) });
    const now = Date.now();

    for (const key of ['a', 'b']) {
      const { id } = store.reserve([scope(key, 100, 'tokens', now + 100)], amount(1), 5000) as {
        ok: true;
        id: string;
      };
      store.commit(id, amount(1));
    }
    vi.setSystemTime(now + 200);

    expect(store.reserve([scope('c', 100)], amount(1), 1000)).toMatchObject({ ok: true });
    expect(warnings).toEqual([]);
    expect(store.read(scope('c', 100)).reserved).toEqual(amount(1));
  });

  it('keeps a finished window that still has a hold, and a window that has not finished', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = memoryUsageStore({ maxScopes: 3 });
    const now = Date.now();
    const done = scope('done', 100, 'tokens', now + 100);
    const busy = scope('busy', 100, 'tokens', now + 100);
    const live = scope('live', 100, 'tokens', now + 10_000);

    const { id } = store.reserve([done], amount(1), 5000) as { ok: true; id: string };
    store.commit(id, amount(1));
    store.reserve([busy], amount(5), 5000);
    store.reserve([live], amount(7), 5000);
    vi.setSystemTime(now + 200);

    store.reserve([scope('new', 100)], amount(1), 1000);

    expect(store.read(done)).toEqual({ spent: amount(0), reserved: amount(0) });
    expect(store.read(busy).reserved).toEqual(amount(5));
    expect(store.read(live).reserved).toEqual(amount(7));
  });

  it('settles a hold whose window was swept without error', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = memoryUsageStore();
    const now = Date.now();
    const gone = scope('gone', 100, 'tokens', now + 100);

    // Nothing is held, so the window is idle and can be swept while the reservations are open.
    const first = store.reserve([gone], amount(0), 5000) as { ok: true; id: string };
    const second = store.reserve([gone], amount(0), 5000) as { ok: true; id: string };
    vi.setSystemTime(now + 200);
    store.reserve([scope('new', 100)], amount(1), 1000);

    expect(() => store.release(first.id)).not.toThrow();
    expect(() => store.commit(second.id, amount(3))).not.toThrow();
    expect(store.read(gone)).toEqual({ spent: amount(0), reserved: amount(0) });
  });

  it('throws past maxScopes when failClosed, holding nothing', () => {
    const store = memoryUsageStore({ maxScopes: 1, failClosed: true });
    const a = scope('a', 100);
    store.reserve([a], amount(1), 1000);

    expect(() => store.reserve([a, scope('b', 100), scope('c', 100)], amount(1), 1000)).toThrow(
      'maxScopes',
    );
    expect(store.read(a).reserved).toEqual(amount(1));
    expect(store.reserve([a], amount(1), 1000)).toMatchObject({ ok: true });
  });

  it('fails open past maxScopes, with one warning', () => {
    const warnings: string[] = [];
    const store = memoryUsageStore({ maxScopes: 1, onWarning: (m) => warnings.push(m) });
    store.reserve([scope('a', 100)], amount(1), 1000);

    // Tracked, the second call would go over the limit of 100. Untracked, nothing stops it.
    for (const _ of [1, 2, 3]) {
      expect(store.reserve([scope('b', 100)], amount(60), 1000)).toMatchObject({ ok: true });
    }

    expect(warnings).toEqual([
      'memoryUsageStore reached maxScopes (1), so new scopes are not limited',
    ]);
  });
});
