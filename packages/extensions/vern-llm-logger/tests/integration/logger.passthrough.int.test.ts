import { LLMError, VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { loggerMiddleware, memorySink } from '../../src/index.js';
import { createMockClient, FakeApiError, settleOutcome, textResponse } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false } as const;

function build(client: ReturnType<typeof createMockClient>['client'], withLogger: boolean) {
  return new VernLLM({
    client,
    model: 'gpt-4o',
    logger: 'silent',
    maxRetries: 0,
    middleware: withLogger ? [loggerMiddleware({ sink: memorySink(), logger: 'silent' })] : [],
  });
}

describe('loggerMiddleware in a real VernLLM', () => {
  it('returns exactly what the call returns without it', async () => {
    const withLogger = await build(createMockClient([textResponse('hello')]).client, true).call(
      call,
    );
    const without = await build(createMockClient([textResponse('hello')]).client, false).call(call);

    expect(withLogger).toBe('hello');
    expect(withLogger).toBe(without);
  });

  it('rethrows the same error the call throws without it', async () => {
    const make = () => createMockClient([new FakeApiError('bad request', 400)]).client;

    const withLogger = await settleOutcome(build(make(), true).call(call));
    const without = await settleOutcome(build(make(), false).call(call));

    expect(withLogger.ok).toBe(false);
    expect(without.ok).toBe(false);
    if (withLogger.ok || without.ok) return;

    expect(withLogger.error).toBeInstanceOf(LLMError);
    expect((withLogger.error as LLMError).type).toBe((without.error as LLMError).type);
    expect((withLogger.error as LLMError).message).toBe((without.error as LLMError).message);
  });

  it('sends the same requests to the provider', async () => {
    const withLogger = createMockClient([textResponse('a')]);
    const without = createMockClient([textResponse('a')]);

    await build(withLogger.client, true).call(call);
    await build(without.client, false).call(call);

    expect(withLogger.calls).toEqual(without.calls);
  });

  it('serves concurrent calls independently', async () => {
    const llm = build(createMockClient([textResponse('same')]).client, true);
    const results = await Promise.all(Array.from({ length: 20 }, () => llm.call(call)));

    expect(results).toEqual(Array.from({ length: 20 }, () => 'same'));
  });

  it('is rejected by the core when two instances share one VernLLM', () => {
    const { client } = createMockClient([textResponse('x')]);

    expect(
      () =>
        new VernLLM({
          client,
          model: 'gpt-4o',
          logger: 'silent',
          middleware: [
            loggerMiddleware({ logger: 'silent' }),
            loggerMiddleware({ logger: 'silent' }),
          ],
        }),
    ).toThrow();
  });
});
