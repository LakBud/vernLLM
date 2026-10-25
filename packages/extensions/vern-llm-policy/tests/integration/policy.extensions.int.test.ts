import { VernLLM, type VernLLMMiddleware } from 'vern-llm';
import { loggerMiddleware, memorySink } from 'vern-llm-logger';
import { routerMiddleware } from 'vern-llm-router';
import { usageBudgetShare, usageMiddleware } from 'vern-llm-usage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { policyMiddleware, type PolicyOptions } from '../../src/index.js';
import { captureLogger, eventProbe, targetChain } from '../helpers.js';

// The real logger, usage and router around policy, as a service would run them. Policy imports
// none of them: they are dev dependencies of this test only.

const call = { userContent: 'hi', jsonMode: false as const, context: { tenantId: 'acme' } };
const now = new Date('2026-06-15T12:00:00Z');
const today = now.toISOString().slice(0, 10);

// One fixed day, so the per day budget and `pricesAsOf` agree however late the suite runs.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
});

const prices = {
  'primary-model': { input: 10, output: 10 },
  'b-model': { input: 1, output: 1 },
  'c-model': { input: 5, output: 5 },
};

function setup(
  policy: PolicyOptions,
  extra: { router?: Parameters<typeof routerMiddleware>[0]; budget?: boolean } = {},
) {
  const chain = targetChain();
  const sink = memorySink();
  const logger = loggerMiddleware({ sink, logger: 'silent' });
  const shares: (number | undefined)[] = [];
  const events = eventProbe();
  const reader: VernLLMMiddleware = {
    name: 'reader',
    position: 1,
    wrap: (_request, next, ctx) => {
      shares.push(usageBudgetShare(ctx));
      return next();
    },
  };
  const usage = usageMiddleware({
    prices,
    pricesAsOf: today,
    attribute: ['tenantId'],
    ...(extra.budget && { budgets: [{ key: 'tenantId', limitUsd: 1, per: 'day' as const }] }),
    logger: 'silent',
  });
  const middleware = [
    logger,
    policyMiddleware({ logger: 'silent', ...policy }),
    usage,
    ...(extra.router ? [routerMiddleware({ logger: 'silent', ...extra.router })] : []),
    reader,
    events.middleware,
  ];
  const llm = new VernLLM({ ...chain.options, defaultMaxTokens: 1000, middleware });
  return { llm, chain, sink, logger, shares, events: events.events };
}

describe('with the logger', () => {
  it('records a denied call as rejected, not as an error', async () => {
    const { llm, sink, logger, chain } = setup({ rules: [{ id: 'lockout', forbid: 'all' }] });

    await expect(llm.call(call)).rejects.toMatchObject({ code: 'policy_denied' });

    const record = sink.entries.map((e) => e.entry).find((e) => e.kind === 'call');
    expect(record).toMatchObject({ outcome: 'rejected' });
    expect(chain.tried()).toEqual([]);
    logger.dispose();
  });

  it('keeps the policy.decision event on the record', async () => {
    const { llm, sink, logger } = setup({ rules: [{ id: 'no-b', forbid: { name: 'b' } }] });

    await llm.call(call);

    const record = sink.entries.map((e) => e.entry).find((e) => e.kind === 'call');
    expect(JSON.stringify(record)).toContain('policy.decision');
    logger.dispose();
  });
});

describe('with usage', () => {
  const lockout = {
    id: 'lockout',
    forbid: 'all' as const,
    when: { context: { tenantId: 'blocked' } },
  };

  it('reserves nothing for a denied call', async () => {
    const used = setup({ rules: [lockout] }, { budget: true });
    const fresh = setup({ rules: [lockout] }, { budget: true });

    for (let i = 0; i < 3; i++) {
      await expect(
        used.llm.call({ ...call, context: { tenantId: 'blocked' } }),
      ).rejects.toMatchObject({ code: 'policy_denied' });
    }
    await used.llm.call(call);
    await fresh.llm.call(call);

    expect(used.chain.tried()).toEqual(['primary']);
    expect(used.shares).toEqual(fresh.shares);
    expect(used.shares[0]).toBeGreaterThan(0);
    used.logger.dispose();
    fresh.logger.dispose();
  });

  it('prices the hold at the most expensive target still allowed', async () => {
    const wide = setup({ rules: [] }, { budget: true });
    const narrow = setup(
      { rules: [{ id: 'no-primary', forbid: { name: 'primary' } }] },
      { budget: true },
    );

    await wide.llm.call(call);
    await narrow.llm.call(call);

    // primary costs the most, so removing it lowers what the call has to reserve.
    expect(narrow.shares[0]!).toBeLessThan(wide.shares[0]!);
    wide.logger.dispose();
    narrow.logger.dispose();
  });
});

describe('with the router', () => {
  const noPrimary = { rules: [{ id: 'no-primary', forbid: { name: 'primary' } }] };

  it('orders only the targets policy left', async () => {
    const { llm, chain, logger } = setup(noPrimary, {
      router: {
        routes: [{ name: 'all', strategy: { type: 'weighted', weights: { b: 1, c: 0 } } }],
      },
    });

    await llm.call(call);

    expect(chain.tried()).toEqual(['b']);
    logger.dispose();
  });

  it('keeps a call alive on an open route list when policy removes the listed target', async () => {
    const log = captureLogger();
    const { llm, chain, logger } = setup(noPrimary, {
      router: { logger: log.logger, routes: [{ name: 'prefer', targets: [['primary'], '*'] }] },
    });

    expect(await llm.call(call)).toBe('b');

    expect(chain.tried()).toEqual(['b']);
    logger.dispose();
  });

  it('fails a closed route list with no_eligible_targets when policy removes every listed target', async () => {
    const { llm, chain, logger } = setup(noPrimary, {
      router: { routes: [{ name: 'only', targets: ['primary'] }] },
    });

    await expect(llm.call(call)).rejects.toMatchObject({ code: 'no_eligible_targets' });

    expect(chain.tried()).toEqual([]);
    logger.dispose();
  });

  it('is warned about once when a route names a target policy removed', async () => {
    const log = captureLogger();
    const { llm, logger } = setup(noPrimary, {
      router: { logger: log.logger, routes: [{ name: 'prefer', targets: [['primary'], '*'] }] },
    });

    await llm.call(call);
    await llm.call(call);

    expect(log.warnings()).toHaveLength(1);
    expect(log.warnings()[0]).toContain('primary');
    logger.dispose();
  });
});
