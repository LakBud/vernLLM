import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { usageMiddleware } from '../../src/index.js';
import { createMockClient, daysAgo, spyStore, textResponse } from '../helpers.js';

const prices = { 'gpt-6-sol': { input: 2, output: 10 } };
const spent = { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 };
const call = { userContent: 'hi', jsonMode: false as const };

describe('concurrent calls', () => {
  it('lets exactly one of 50 parallel calls through a budget with room for one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { client, calls } = createMockClient([
      async () => {
        await gate;
        return textResponse('ok', spent);
      },
    ]);
    const llm = new VernLLM({
      client,
      model: 'gpt-6-sol',
      maxRetries: 0,
      logger: 'silent',
      defaultMaxTokens: 50,
      middleware: [
        usageMiddleware({
          prices,
          pricesAsOf: daysAgo(1),
          attribute: ['tenantId'],
          budgets: [{ key: 'tenantId', limitTokens: 100, per: 'day' }],
          logger: 'silent',
        }),
      ],
    });

    const results = Array.from({ length: 50 }, () =>
      llm.call({ ...call, context: { tenantId: 'acme' } }).then(
        () => 'ok',
        (error: { code?: string }) => error.code,
      ),
    );
    setTimeout(release, 10);
    const outcomes = await Promise.all(results);

    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'budget_exceeded')).toHaveLength(49);
    expect(calls).toHaveLength(1);
  });

  it('holds nothing in any scope when one of them has no room', async () => {
    const spy = spyStore();
    const { client } = createMockClient([textResponse('ok', spent)]);
    const llm = new VernLLM({
      client,
      model: 'gpt-6-sol',
      maxRetries: 0,
      logger: 'silent',
      defaultMaxTokens: 50,
      middleware: [
        usageMiddleware({
          prices,
          pricesAsOf: daysAgo(1),
          attribute: ['tenantId', 'team'],
          budgets: [
            { key: 'tenantId', limitTokens: 10_000, per: 'day' },
            { key: 'team', limitTokens: 120, per: 'day' },
          ],
          store: spy.store,
          logger: 'silent',
        }),
      ],
    });

    await llm.call({ ...call, context: { tenantId: 't1', team: 'x' } });
    await expect(
      llm.call({ ...call, context: { tenantId: 't2', team: 'x' } }),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });

    const denied = spy.reserved()[1]!;
    const tenantScope = denied.scopes.find((s) => s.label.startsWith('tenantId'))!;
    expect(await spy.store.read(tenantScope)).toEqual({
      spent: { nanoUsd: 0, tokens: 0 },
      reserved: { nanoUsd: 0, tokens: 0 },
    });
  });
});
