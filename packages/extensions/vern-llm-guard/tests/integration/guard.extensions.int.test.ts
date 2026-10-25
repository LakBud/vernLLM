import { loggerMiddleware, memorySink } from 'vern-llm-logger';
import { policyMiddleware } from 'vern-llm-policy';
import { usageBudgetShare, usageMiddleware } from 'vern-llm-usage';
import { describe, expect, it } from 'vitest';

import { guardLabels, guardLogFields, patterns } from '../../src/index.js';
import { createStreamClient, harness, textDeltas } from '../helpers.js';

import type { StreamChunk, VernLLMMiddleware, VernLLMOptions } from 'vern-llm';

// The real logger, usage and policy around the guard, as a service would run them. The guard
// imports none of them: they are dev dependencies of this test only.

const call = { userContent: 'hi', jsonMode: false as const, context: { tenantId: 'acme' } };
const withEmail = { ...call, userContent: 'Write to jane@acme.com please' };
const withKey = { ...call, userContent: 'My key is AKIAIOSFODNN7EXAMPLE' };

const pii = { id: 'pii', detect: patterns(['email']) };
const secrets = { id: 'secrets', detect: patterns(['secrets']), action: 'block' as const };

function setup(checks = [pii, secrets], budget = false, vern: Partial<VernLLMOptions> = {}) {
  const sink = memorySink();
  const logger = loggerMiddleware({ sink, logger: 'silent', enrich: guardLogFields });
  const shares: (number | undefined)[] = [];
  const reader: VernLLMMiddleware = {
    name: 'reader',
    position: 1,
    wrap: (_request, next, ctx) => {
      shares.push(usageBudgetShare(ctx));
      return next();
    },
  };
  const policy = policyMiddleware({
    logger: 'silent',
    targets: { primary: { zdr: false }, b: { zdr: true } },
    labels: guardLabels,
    rules: [{ id: 'pii-zdr', forbid: { zdr: false }, when: { labels: 'pii' } }],
  });
  const usage = usageMiddleware({
    prices: { 'primary-model': { input: 1, output: 1 }, 'b-model': { input: 1, output: 1 } },
    pricesAsOf: new Date().toISOString().slice(0, 10),
    attribute: ['tenantId'],
    ...(budget && { budgets: [{ key: 'tenantId', limitUsd: 1, per: 'day' as const }] }),
    logger: 'silent',
  });
  const built = harness(
    { checks },
    { ...vern, defaultMaxTokens: 1000, middleware: [logger, policy, usage, reader] },
  );
  const records = () => sink.entries.map((entry) => entry.entry).filter((e) => e.kind === 'call');
  return { ...built, logger, shares, records };
}

describe('with policy', () => {
  it('sends a call with pii only to the targets that keep nothing', async () => {
    const { llm, primary, b, logger } = setup();

    await llm.call(withEmail);

    expect(primary.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(1);
    logger.dispose();
  });

  it('leaves a call with nothing found on the first target', async () => {
    const { llm, primary, logger } = setup();

    await llm.call(call);

    expect(primary.calls).toHaveLength(1);
    logger.dispose();
  });
});

describe('with usage', () => {
  it('reserves no budget for a blocked call', async () => {
    const used = setup([pii, secrets], true);
    const fresh = setup([pii, secrets], true);

    await expect(used.llm.call(withKey)).rejects.toMatchObject({ code: 'content_blocked' });
    await used.llm.call(call);
    await fresh.llm.call(call);

    expect(used.shares).toHaveLength(1);
    expect(used.shares).toEqual(fresh.shares);
    expect(used.primary.calls).toHaveLength(1);
    used.logger.dispose();
    fresh.logger.dispose();
  });
});

describe('with the logger', () => {
  it('records a blocked call as rejected, with the guard result on it', async () => {
    const { llm, records, logger } = setup();

    await expect(llm.call(withKey)).rejects.toMatchObject({ code: 'content_blocked' });

    const [record] = records();
    expect(record).toMatchObject({ outcome: 'rejected' });
    expect(JSON.stringify(record)).toContain('guard.result');
    expect(JSON.stringify(record)).not.toContain('AKIA');
    logger.dispose();
  });

  it('carries the outcome and labels of a call that went through', async () => {
    const { llm, records, logger } = setup();

    await llm.call(withEmail);

    const [record] = records();
    expect(JSON.stringify(record)).toContain('guard_outcome');
    expect(JSON.stringify(record)).toContain('guard_labels');
    expect(JSON.stringify(record)).not.toContain('jane@acme.com');
    logger.dispose();
  });

  it('carries the guard summary of a stream once it has ended', async () => {
    const { client } = createStreamClient(textDeltas('all done', 4));
    const { llm, records, logger } = setup([pii, secrets], false, { client });

    const stream = (await llm.call({ ...call, stream: true })) as unknown as {
      chunks: AsyncIterable<StreamChunk>;
      finalResult: Promise<unknown>;
    };
    for await (const _chunk of stream.chunks) void _chunk;
    await stream.finalResult;

    expect(JSON.stringify(records()[0])).toContain('guard_outcome');
    logger.dispose();
  });
});
