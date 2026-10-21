import { LLMError, VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { usageMiddleware, type UsageStore } from '../../src/index.js';
import {
  captureLogger,
  createMockClient,
  createMockStreamingClient,
  daysAgo,
  spyStore,
  textResponse,
} from '../helpers.js';

const prices = { 'gpt-6-sol': { input: 2, output: 10 } };
const spent = { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 };
const call = { userContent: 'hi', jsonMode: false as const, context: { tenantId: 'acme' } };

function setup(
  store: UsageStore,
  onStoreError?: 'allow' | 'deny',
  response = textResponse('ok', spent),
) {
  const { logger, errors } = captureLogger();
  const { client, calls } = createMockClient([response]);
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
        budgets: [{ key: 'tenantId', limitTokens: 1_000, per: 'day' }],
        store,
        onStoreError,
        logger,
      }),
    ],
  });
  return { llm, calls, errors };
}

const failing = (method: keyof UsageStore): UsageStore => {
  const base = spyStore().store;
  return {
    ...base,
    [method]: () => {
      throw new Error(`${method} is down`);
    },
  } as UsageStore;
};

describe('store failures', () => {
  it('sends the call unmetered and logs it when the store fails and onStoreError is allow', async () => {
    const { llm, calls, errors } = setup(failing('reserve'));

    await expect(llm.call(call)).resolves.toBe('ok');

    expect(calls).toHaveLength(1);
    expect(errors()).toEqual(['[VernLLM] usage: reserve failed']);
  });

  it('rejects like an exceeded budget, with the cause, when onStoreError is deny', async () => {
    const { llm, calls } = setup(failing('reserve'), 'deny');

    const error = await llm.call(call).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({ type: 'quota_exceeded', code: 'budget_exceeded' });
    expect((error as LLMError).cause).toMatchObject({ message: 'reserve is down' });
    expect(calls).toHaveLength(0);
  });

  it.each(['commit', 'release'] as const)('never breaks a call when %s throws', async (method) => {
    // `commit` settles a call that reported usage, `release` frees one that reported none.
    const response = method === 'commit' ? textResponse('ok', spent) : textResponse('ok');
    const { llm, errors } = setup(failing(method), undefined, response);

    await expect(llm.call(call)).resolves.toBe('ok');

    expect(errors()).toEqual([`[VernLLM] usage: ${method} failed`]);
  });

  it('never breaks a stream when commit throws', async () => {
    const { logger, errors } = captureLogger();
    const llm = new VernLLM({
      client: createMockStreamingClient([
        { type: 'text-delta', delta: 'hi' },
        { type: 'usage', usage: spent },
      ]).client,
      model: 'gpt-6-sol',
      maxRetries: 0,
      logger: 'silent',
      defaultMaxTokens: 50,
      middleware: [
        usageMiddleware({
          prices,
          pricesAsOf: daysAgo(1),
          attribute: ['tenantId'],
          budgets: [{ key: 'tenantId', limitTokens: 1_000, per: 'day' }],
          store: failing('commit'),
          logger,
        }),
      ],
    });

    const stream = await llm.call({ ...call, stream: true as const });
    for await (const chunk of stream.chunks) void chunk;

    await expect(stream.finalResult).resolves.toBe('hi');
    expect(errors()).toEqual(['[VernLLM] usage: commit failed']);
  });

  it('never breaks a call when an asynchronous commit rejects', async () => {
    const rejecting: UsageStore = {
      ...spyStore().store,
      commit: async () => {
        throw new Error('commit down');
      },
    };
    const { llm, errors } = setup(rejecting);

    await expect(llm.call(call)).resolves.toBe('ok');

    expect(errors()).toEqual(['[VernLLM] usage: commit failed']);
  });

  it('never breaks a call when an asynchronous release rejects', async () => {
    const rejecting: UsageStore = {
      ...spyStore().store,
      release: async () => {
        throw new Error('release down');
      },
    };
    // No usage in the response, so the hold is released instead of committed.
    const { llm, errors } = setup(rejecting, undefined, textResponse('ok'));

    await expect(llm.call(call)).resolves.toBe('ok');

    expect(errors()).toEqual(['[VernLLM] usage: release failed']);
  });

  it('accepts a store that answers asynchronously', async () => {
    const spy = spyStore();
    const slow: UsageStore = {
      reserve: async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return spy.store.reserve(...args);
      },
      commit: spy.store.commit,
      release: spy.store.release,
      read: spy.store.read,
    };
    const { llm } = setup(slow);

    await expect(llm.call(call)).resolves.toBe('ok');
    expect(spy.open()).toBe(0);
  });
});
