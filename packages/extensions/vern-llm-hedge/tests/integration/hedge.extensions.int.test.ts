import { VernLLM } from 'vern-llm';
import { guardMiddleware, keywords, patterns } from 'vern-llm-guard';
import { loggerMiddleware, memorySink } from 'vern-llm-logger';
import { policyFlags, policyMiddleware, type PolicyOptions } from 'vern-llm-policy';
import { routerMiddleware } from 'vern-llm-router';
import { usageMiddleware } from 'vern-llm-usage';
import { describe, expect, it, vi } from 'vitest';

import {
  hedgeDimension,
  hedgeLogFields,
  hedgeMiddleware,
  promptSizeDimension,
} from '../../src/index.js';
import { eventProbe, heldClient, lastUserText, settle, targetChain, waitFor } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

function setup() {
  const primary = heldClient('primary');
  const chain = targetChain({ primary: primary.client });
  const sink = memorySink();
  const logger = loggerMiddleware({
    sink,
    minSamples: 1,
    logger: 'silent',
    // Named here, so the test does not depend on what the logger keeps by default.
    customEvents: ['hedge.*'],
    dimensions: { size: promptSizeDimension, hedge: hedgeDimension },
    enrich: hedgeLogFields,
  });
  const hedge = hedgeMiddleware({
    stats: logger.stats,
    delay: { quantile: 0.95, minMs: 25 },
    budget: { ratio: 1, burst: 1 },
    statsTtlMs: 0,
    logger: 'silent',
  });
  const llm = new VernLLM({ ...chain.options, middleware: [logger, hedge] });

  /** A call the first target answers after `ms`, with 500 prompt tokens of usage. */
  async function answeredAfter(ms: number) {
    const index = primary.requests.length;
    const pending = llm.call(call);
    await waitFor(() => primary.requests.length === index + 1);
    await settle(ms);
    primary.requests[index]!.answer('primary', 500);
    await pending;
  }

  const records = () =>
    sink.entries.map((entry) => entry.entry).filter((entry) => entry.kind === 'call');

  return { llm, primary, logger, answeredAfter, records };
}

describe('with the logger', () => {
  it('has no delay, and so no hedge, until the logger has samples', async () => {
    const { answeredAfter, records } = setup();

    await answeredAfter(10);

    expect(records()[0]).toMatchObject({
      custom: { 'hedge.decision': [{ v: 1, outcome: 'no_data' }] },
      fields: { hedge: 'no_data' },
    });
  });

  it('reads the delay from the first target`s own attemptMs, in the series its prompt size is in', async () => {
    const { answeredAfter, logger, records } = setup();
    await answeredAfter(10);
    const quantile = vi.spyOn(logger.stats, 'quantile');

    await answeredAfter(1);

    // The `size` dimension is named by the user and read by this name: the call is looked up in
    // the series the logger recorded the first call under.
    expect(quantile.mock.calls[0]).toEqual([
      { provider: 'primary', streaming: 'false', size: 'xs' },
      0.95,
      'attemptMs',
    ]);
    expect(quantile.mock.results[0]!.value).toBeGreaterThan(0);
    expect(records()[1]).toMatchObject({ fields: { hedge: 'not_needed' } });
    expect(
      (records()[1] as { fields: Record<string, number> }).fields.hedge_delay_ms,
    ).toBeGreaterThanOrEqual(25);
  });

  it('records a hedged call once, from the chain that answered', async () => {
    const { llm, answeredAfter, records } = setup();
    await answeredAfter(10);
    await answeredAfter(1);

    // The first target stays silent past the delay, so the hedge to `b` answers.
    expect(await llm.call(call)).toBe('b');

    expect(records()).toHaveLength(3);
    expect(records()[2]).toMatchObject({
      provider: 'b',
      chains: 2,
      chain: 1,
      custom: { 'hedge.decision': [{ outcome: 'won', target: 'b' }] },
      fields: { hedge: 'won' },
    });
  });

  it('does not pull the first target`s latency down with the hedge that beat it', async () => {
    const { llm, answeredAfter, logger } = setup();
    await answeredAfter(10);
    await answeredAfter(1);
    await llm.call(call);

    const series = logger.stats
      .snapshot()
      .series.filter((s) => s.metric === 'attemptMs' && s.dimensions.provider === 'primary');

    // Only the two calls the first target answered itself; the hedged call is under `b`.
    expect(series.reduce((total, s) => total + s.count, 0)).toBe(2);
  });

  it('splits the logger snapshot by how the hedge went', async () => {
    const { llm, answeredAfter, logger } = setup();
    await answeredAfter(10);
    await answeredAfter(1);
    await llm.call(call);

    const outcomes = new Set(
      logger.stats
        .snapshot()
        // The logger also keeps one series over every call, which has no dimensions at all.
        .series.filter((s) => s.metric === 'durationMs' && s.dimensions.hedge !== undefined)
        .map((s) => s.dimensions.hedge),
    );

    expect(outcomes).toEqual(new Set(['no_data', 'not_needed', 'won']));
  });
});

const budget = { ratio: 1, burst: 1 };
const today = new Date().toISOString().slice(0, 10);

describe('with the router', () => {
  it('hedges to the router`s second choice, not to the next target in the configured order', async () => {
    const b = heldClient('b');
    const chain = targetChain({ b: b.client });
    const usage = usageMiddleware({
      prices: {
        'primary-model': { input: 10, output: 10 },
        'b-model': { input: 1, output: 1 },
        'c-model': { input: 5, output: 5 },
      },
      pricesAsOf: today,
      logger: 'silent',
    });
    const logger = loggerMiddleware({ sink: memorySink(), minSamples: 1, logger: 'silent' });
    const holder: { llm?: VernLLM } = {};
    const router = routerMiddleware({
      logger: 'silent',
      health: () => holder.llm as never,
      stats: logger.stats,
      cost: usage.costFor,
      random: () => 0.99,
      routes: [{ name: 'cheap', strategy: { type: 'rank', weights: { cost: 1 }, explore: 0 } }],
    });
    const hedge = hedgeMiddleware({ delay: 10, budget, logger: 'silent' });
    const llm = new VernLLM({ ...chain.options, middleware: [logger, usage, router, hedge] });
    holder.llm = llm;

    // The router puts `b` first, so the slow call is `b`, and the hedge goes to the next cheapest.
    expect(await llm.call(call)).toBe('c');

    expect(chain.tried()).toEqual(['b', 'c']);
    logger.dispose();
  });
});

describe('with the policy', () => {
  function withPolicy(rules: PolicyOptions['rules']) {
    const primary = heldClient('primary');
    const chain = targetChain({ primary: primary.client });
    const probe = eventProbe('hedge.decision');
    const policy = policyMiddleware({ logger: 'silent', rules });
    const hedge = hedgeMiddleware({ delay: 10, budget, logger: 'silent' });
    const llm = new VernLLM({
      ...chain.options,
      middleware: [probe.middleware as never, policy, hedge],
    });
    return { llm, chain, events: probe.events as Record<string, unknown>[] };
  }

  it('never hedges to a target the policy removed', async () => {
    const { llm, chain, events } = withPolicy([{ id: 'no-b', forbid: { name: 'b' } }]);

    expect(await llm.call(call)).toBe('c');

    expect(chain.tried()).toEqual(['primary', 'c']);
    expect(events[0]).toMatchObject({ outcome: 'won', target: 'c' });
  });

  it('skips when the `duplicateSends` flag recipe says the content must not go to two providers', async () => {
    const primary = heldClient('primary');
    const chain = targetChain({ primary: primary.client });
    const probe = eventProbe('hedge.decision');
    const policy = policyMiddleware({
      logger: 'silent',
      rules: [{ id: 'sensitive', set: { duplicateSends: false } }],
    });
    const hedge = hedgeMiddleware({
      delay: 10,
      budget,
      logger: 'silent',
      when: (ctx) => policyFlags(ctx).duplicateSends !== false,
    });
    const llm = new VernLLM({
      ...chain.options,
      middleware: [probe.middleware as never, policy, hedge],
    });

    const pending = llm.call(call);
    await waitFor(() => primary.requests.length === 1);
    await settle(30);
    primary.requests[0]!.answer();

    expect(await pending).toBe('primary');
    expect(chain.tried()).toEqual(['primary']);
    expect(probe.events[0]).toMatchObject({ outcome: 'not_allowed' });
  });
});

describe('with the guard', () => {
  const pii = { id: 'pii', detect: patterns(['email']), action: 'redact' as const };
  const leak = {
    id: 'leak',
    detect: keywords(['hunter2']),
    action: 'block' as const,
    on: 'output' as const,
  };
  const tokenOf = (text: string) => /x[0-9a-f]{6}@redacted\.invalid/.exec(text)?.[0];

  function withGuard(checks: Parameters<typeof guardMiddleware>[0]['checks']) {
    const primary = heldClient('primary');
    const b = heldClient('b');
    const chain = targetChain({ primary: primary.client, b: b.client });
    const guard = guardMiddleware({ version: 'v1', logger: 'silent', checks });
    const hedge = hedgeMiddleware({ delay: 10, budget, logger: 'silent' });
    const llm = new VernLLM({ ...chain.options, middleware: [guard, hedge] });
    return { llm, primary, b };
  }

  it('redacts the hedge`s attempt for its own target, and restores the kept answer once', async () => {
    const { llm, primary, b } = withGuard([pii]);

    const pending = llm.call({ userContent: 'write to jane@acme.com', jsonMode: false as const });
    await waitFor(() => b.requests.length === 1);

    const first = lastUserText(primary.requests[0]!.params);
    const second = lastUserText(b.requests[0]!.params);
    expect(first).not.toContain('jane@acme.com');
    expect(second).not.toContain('jane@acme.com');

    b.requests[0]!.answer(`ok ${tokenOf(second)}`);
    expect(await pending).toBe('ok jane@acme.com');
  });

  it('checks the answer that is kept, so a hedge that wins with a forbidden answer is blocked', async () => {
    const { llm, b } = withGuard([leak]);

    const pending = llm.call(call);
    await waitFor(() => b.requests.length === 1);
    b.requests[0]!.answer('the password is hunter2');

    await expect(pending).rejects.toMatchObject({ code: 'content_blocked' });
  });
});

describe('with usage', () => {
  const prices = {
    'primary-model': { input: 2, output: 2 },
    'b-model': { input: 1, output: 1 },
  };

  it('counts what both chains spent when both reported', async () => {
    // The cost of the first target answering alone, as the control.
    const alone = heldClient('primary');
    const control = usageMiddleware({ prices, pricesAsOf: today, logger: 'silent' });
    const controlLlm = new VernLLM({
      ...targetChain({ primary: alone.client }).options,
      middleware: [control],
    });
    const answered = controlLlm.call(call);
    await waitFor(() => alone.requests.length === 1);
    alone.requests[0]!.answer('primary', 1_000);
    await answered;

    const primary = heldClient('primary');
    const b = heldClient('b');
    const chain = targetChain({ primary: primary.client, b: b.client });
    const usage = usageMiddleware({ prices, pricesAsOf: today, logger: 'silent' });
    const hedge = hedgeMiddleware({ delay: 10, budget, logger: 'silent' });
    const llm = new VernLLM({ ...chain.options, middleware: [usage, hedge] });

    const pending = llm.call(call);
    await waitFor(() => b.requests.length === 1);
    // Both answer in the same tick, so both report their spend before one is kept.
    b.requests[0]!.answer('b', 1_000);
    primary.requests[0]!.answer('primary', 1_000);
    await pending;

    const totals = usage.totals();
    expect(totals.calls).toBe(1);
    expect(totals.estimatedCostUsd).toBeGreaterThan(control.totals().estimatedCostUsd);
  });
});
