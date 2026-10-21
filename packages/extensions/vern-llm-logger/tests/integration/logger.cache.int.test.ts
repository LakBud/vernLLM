import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { loggerMiddleware, memorySink, type CallLogRecord } from '../../src/index.js';
import { createMockClient, createMockStreamingClient, sleep, textResponse } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

function setup(client: ConstructorParameters<typeof VernLLM>[0]['client']) {
  const sink = memorySink();
  const llm = new VernLLM({
    client,
    model: 'gpt-4o',
    maxRetries: 0,
    logger: 'silent',
    middleware: [loggerMiddleware({ sink, logger: 'silent' })],
  });
  return { llm, records: () => sink.entries.map(({ entry }) => entry as CallLogRecord) };
}

describe('cachedCall', () => {
  it('marks the second call a hit, and not the first', async () => {
    const { llm, records } = setup(createMockClient([textResponse('a')]).client);
    const params = { cacheKey: 'k', ttl: 1000, call };

    await llm.cachedCall(params);
    await llm.cachedCall(params);

    expect(records()).toHaveLength(2);
    expect(records()[0]).not.toHaveProperty('cache');
    expect(records()[0]!.attempts).toBe(1);
    expect(records()[1]).toMatchObject({ cache: 'hit', attempts: 0, outcome: 'ok' });
    expect(records()[1]!.path).toEqual([]);
  });

  it('marks a caller that shared an in flight call a join', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { llm, records } = setup(
      createMockClient([async () => (await gate, textResponse('shared'))]).client,
    );
    const params = { cacheKey: 'j', ttl: 1000, call };

    const first = llm.cachedCall(params);
    const second = llm.cachedCall(params);
    release();
    await Promise.all([first, second]);

    const caches = records().map((record) => record.cache);
    expect(caches.filter((cache) => cache === 'join')).toHaveLength(1);
    expect(caches.filter((cache) => cache === undefined)).toHaveLength(1);
  });

  it('marks a streamed caller that shared an in flight call a join', async () => {
    const { llm, records } = setup(
      createMockStreamingClient([[{ type: 'text-delta', delta: 'x' }]]).client,
    );
    const params = { cacheKey: 'sj', ttl: 1000, call: { ...call, stream: true as const } };

    const streams = await Promise.all([llm.cachedCall(params), llm.cachedCall(params)]);
    await Promise.all(streams.map((stream) => stream.finalResult));
    await sleep(0);

    const caches = records().map((record) => record.cache);
    expect(caches.filter((cache) => cache === 'join')).toHaveLength(1);
    expect(caches.filter((cache) => cache === undefined)).toHaveLength(1);
    expect(records().find((record) => record.cache === 'join')).toMatchObject({
      streaming: true,
      attempts: 0,
    });
  });

  it('marks a streamed hit at settle', async () => {
    const { llm, records } = setup(
      createMockStreamingClient([[{ type: 'text-delta', delta: 'x' }]]).client,
    );
    const params = { cacheKey: 's', ttl: 1000, call: { ...call, stream: true as const } };

    for (let i = 0; i < 2; i++) {
      const stream = await llm.cachedCall(params);
      await stream.finalResult;
    }
    await sleep(0);

    expect(records()).toHaveLength(2);
    expect(records()[0]).not.toHaveProperty('cache');
    expect(records()[1]).toMatchObject({ cache: 'hit', streaming: true, attempts: 0 });
  });

  it('never marks an ordinary call', async () => {
    const { llm, records } = setup(createMockClient([textResponse('a')]).client);

    await llm.call(call);

    expect(records()[0]).not.toHaveProperty('cache');
  });
});
