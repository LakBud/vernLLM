import { describe, expect, it, vi } from 'vitest';

import { memoryUsageStore, type Scope, type UsageStore } from '../../../../src/index.js';
import { BudgetWarnings } from '../../../../src/internal/budgets/warnings.js';
import { createGuard } from '../../../../src/internal/guard.utils.js';
import { captureLogger } from '../../../helpers.js';

import type { PreDispatchContext } from 'vern-llm';

const scope = (key: string, resetsAtMs = Date.now() + 60_000): Scope => ({
  key,
  label: key,
  unit: 'tokens',
  limit: 100,
  resetsAtMs,
});

function setup(store: UsageStore = memoryUsageStore(), maxRemembered?: number) {
  const { logger, errors } = captureLogger();
  const emit = vi.fn();
  const ctx = { emit } as unknown as PreDispatchContext;
  const warnings = new BudgetWarnings(0.5, store, createGuard(logger), maxRemembered);
  return { warnings, emit, ctx, errors, store };
}

async function spend(store: UsageStore, s: Scope, tokens: number) {
  const outcome = (await store.reserve([s], { nanoUsd: 0, tokens }, 1000)) as { id: string };
  await store.commit(outcome.id, { nanoUsd: 0, tokens });
}

describe('BudgetWarnings, when emitting fails', () => {
  it('logs it and never throws', async () => {
    const { warnings, emit, ctx, errors, store } = setup();
    emit.mockImplementation(() => {
      throw new Error('emit broke');
    });
    const s = scope('a');
    await spend(store, s, 80);

    expect(await warnings.check([s], ctx)).toBeUndefined();

    expect(errors()).toEqual(['[VernLLM] usage: warning failed']);
  });
});

describe('BudgetWarnings', () => {
  it('stays quiet below the threshold, then warns once at it', async () => {
    const { warnings, emit, ctx, store } = setup();
    const s = scope('a');

    await spend(store, s, 40);
    await warnings.check([s], ctx);
    expect(emit).not.toHaveBeenCalled();

    await spend(store, s, 20);
    await warnings.check([s], ctx);
    await warnings.check([s], ctx);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('usage.budget_warning', {
      v: 1,
      scope: 'a',
      unit: 'tokens',
      limit: 100,
      used: 0.6,
    });
  });

  it('warns on a dollar scope too, reporting its limit in dollars', async () => {
    const { warnings, emit, ctx, store } = setup();
    const dollars: Scope = { ...scope('usd'), unit: 'usd', limit: 2_000_000_000 };
    const outcome = (await store.reserve(
      [dollars],
      { nanoUsd: 1_500_000_000, tokens: 0 },
      1000,
    )) as {
      id: string;
    };
    await store.commit(outcome.id, { nanoUsd: 1_500_000_000, tokens: 0 });

    await warnings.check([dollars], ctx);

    expect(emit).toHaveBeenCalledWith('usage.budget_warning', {
      v: 1,
      scope: 'usd',
      unit: 'usd',
      limit: 2,
      used: 0.75,
    });
  });

  it('logs a failing store read and carries on with the next scope', async () => {
    const real = memoryUsageStore();
    const first = scope('broken');
    const second = scope('fine');
    const store: UsageStore = {
      ...real,
      read: (s) => {
        if (s.key === 'broken') throw new Error('read is down');
        return real.read(s);
      },
    };
    const { warnings, emit, ctx, errors } = setup(store);
    await spend(store, second, 90);

    await warnings.check([first, second], ctx);

    expect(errors()).toEqual(['[VernLLM] usage: warning failed']);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('works with a store that reads asynchronously, in scope order, and logs a rejected read', async () => {
    const real = memoryUsageStore();
    const broken = scope('broken');
    const fine = scope('fine');
    const store: UsageStore = {
      ...real,
      read: async (s) => {
        if (s.key === 'broken') throw new Error('read is down');
        return real.read(s);
      },
    };
    const { warnings, emit, ctx, errors } = setup(store);
    await spend(store, fine, 90);

    const pending = warnings.check([broken, fine], ctx);
    expect(pending).toBeInstanceOf(Promise);
    await pending;

    expect(errors()).toEqual(['[VernLLM] usage: warning failed']);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('answers synchronously when the store does', () => {
    const { warnings, ctx } = setup();

    expect(warnings.check([scope('a')], ctx)).toBeUndefined();
  });

  it('does nothing without warnAt', async () => {
    const store = memoryUsageStore();
    const read = vi.spyOn(store, 'read');
    const emit = vi.fn();
    const warnings = new BudgetWarnings(undefined, store, createGuard('silent'));

    await warnings.check([scope('a')], { emit } as unknown as PreDispatchContext);

    expect(read).not.toHaveBeenCalled();
  });

  it('stays bounded: past its cap it forgets finished windows first, then the oldest', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { warnings, emit, ctx, store } = setup(memoryUsageStore(), 2);
    const ended = scope('ended', Date.now() + 1_000);
    const live = scope('live');
    const next = scope('next');
    const last = scope('last');
    for (const s of [ended, live, next, last]) await spend(store, s, 90);

    await warnings.check([ended, live], ctx);
    vi.setSystemTime(Date.now() + 2_000);
    // Full: `ended` has finished, so it is the one forgotten and `live` is still remembered.
    await warnings.check([next], ctx);
    await warnings.check([live, ended], ctx);
    expect(emit.mock.calls.map(([, data]) => (data as { scope: string }).scope)).toEqual([
      'ended',
      'live',
      'next',
      'ended',
    ]);

    // Full of live scopes: the oldest goes, so it warns again.
    await warnings.check([last], ctx);
    await warnings.check([live], ctx);
    expect(emit).toHaveBeenCalledTimes(6);
    vi.useRealTimers();
  });
});

describe('BudgetWarnings, with concurrent checks on an asynchronous store', () => {
  it('warns once for a scope even when several reads are in flight together', async () => {
    const inner = memoryUsageStore();
    const slow: UsageStore = {
      reserve: (scopes, amount, ttlMs) => inner.reserve(scopes, amount, ttlMs),
      commit: (id, actual) => inner.commit(id, actual),
      release: (id) => inner.release(id),
      read: async (s) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return inner.read(s);
      },
    };
    const { warnings, emit, ctx } = setup(slow);
    const s = scope('a');
    await spend(slow, s, 80);

    await Promise.all([
      warnings.check([s], ctx),
      warnings.check([s], ctx),
      warnings.check([s], ctx),
    ]);

    expect(emit).toHaveBeenCalledTimes(1);
  });
});
