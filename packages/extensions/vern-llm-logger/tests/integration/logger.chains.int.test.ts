import { VernLLM, type VernLLMMiddleware, type WireStreamChunk } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { loggerMiddleware, memorySink, type CallLogRecord } from '../../src/index.js';
import {
  createMockClient,
  createMockStreamingClient,
  FakeApiError,
  sleep,
  textResponse,
} from '../helpers.js';

// A real VernLLM with a middleware that calls `next.again()`, so the logger sees what the core
// really sends: events and attempts that carry a chain.

const call = { userContent: 'hi', jsonMode: false as const };
const streamCall = { ...call, stream: true as const };
const USAGE = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
const ok = (text = 'ok') => textResponse(text, USAGE);
const serverError = () => new FakeApiError('boom: secret prompt text', 500);

type Script = Parameters<typeof createMockClient>[0];

/** An answer that never comes, until the core cancels its attempt. */
const held = (_params: unknown, signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(new Error('cancelled'))),
  );

/** A stream that opens no chunk, until the core cancels it. */
const heldStream = (signal: AbortSignal): AsyncIterable<WireStreamChunk> => ({
  [Symbol.asyncIterator]: () => ({
    next: () =>
      new Promise<IteratorResult<WireStreamChunk>>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled'))),
      ),
  }),
});

/** Starts the call, starts it again after `delayMs` (on `targets` if given), keeps the first answer. */
const rerunAfter = (delayMs: number, targets?: readonly string[]): VernLLMMiddleware => ({
  name: 'rerun-after',
  reruns: true,
  wrap: async (_request, next) => {
    const main = next();
    await sleep(delayMs);
    return Promise.race([main, next.again!(targets ? { targets } : undefined)]);
  },
});

/** Runs two chains at once and keeps the main chain's result or error, as a race of two would. */
const rerunAtOnce: VernLLMMiddleware = {
  name: 'rerun-at-once',
  reruns: true,
  wrap: async (_request, next) => {
    const [main] = await Promise.allSettled([next(), next.again!()]);
    if (main.status === 'rejected') throw main.reason;
    return main.value;
  },
};

function setup(
  client: ReturnType<typeof createMockClient>['client'],
  wrapper: VernLLMMiddleware,
  extra: {
    maxRetries?: number;
    fallback?: ConstructorParameters<typeof VernLLM>[0]['fallback'];
  } = {},
) {
  const sink = memorySink();
  const llm = new VernLLM({
    model: 'gpt-4o',
    maxRetries: 0,
    baseDelayMs: 1,
    logger: 'silent',
    client,
    ...extra,
    middleware: [wrapper, loggerMiddleware({ sink, logger: 'silent' })],
  });
  return { llm, records: () => sink.entries.map(({ entry }) => entry as CallLogRecord) };
}

const mock = (script: Script) => createMockClient(script).client;

describe('a rerun of the same target', () => {
  it('records the chain that answered, with its own latency and usage', async () => {
    const { llm, records } = setup(
      mock([held, async () => (await sleep(10), ok('second'))]),
      rerunAfter(150),
    );

    expect(await llm.call(call)).toBe('second');

    const [record] = records();
    expect(record).toMatchObject({ outcome: 'ok', attempts: 2, chains: 2, chain: 1 });
    expect(record!.usage!.totalTokens).toBe(7);
    // The answering chain began 150 ms into the call and took about 10 ms.
    expect(record!.durationMs).toBeGreaterThanOrEqual(150);
    expect(record!.attemptMs!).toBeLessThan(100);
  });

  it('records the main chain when it answers first, and never leaves the other open', async () => {
    const { llm, records } = setup(
      mock([async () => (await sleep(5), ok('first')), held]),
      rerunAfter(20),
    );

    expect(await llm.call(call)).toBe('first');

    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ outcome: 'ok', attempts: 2, chains: 2, chain: 0 });
  });

  it('writes no chain fields when the wrap never reruns', async () => {
    const { llm, records } = setup(mock([ok()]), {
      name: 'plain',
      reruns: true,
      wrap: (_request, next) => next(),
    });

    await llm.call(call);

    expect(records()[0]).not.toHaveProperty('chains');
    expect(records()[0]).not.toHaveProperty('chain');
  });
});

describe('a rerun on another target', () => {
  it('names the target of the kept chain and lists only its path', async () => {
    const { llm, records } = setup(mock([held]), rerunAfter(30, ['backup']), {
      fallback: { client: mock([ok('from backup')]), model: 'claude-x', name: 'backup' },
    });

    expect(await llm.call(call)).toBe('from backup');

    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      outcome: 'ok',
      provider: 'backup',
      model: 'claude-x',
      fallbackIndex: 0,
      attempts: 2,
      chains: 2,
      chain: 1,
      path: [{ provider: 'backup', model: 'claude-x', attempts: 1, outcome: 'ok' }],
    });
  });
});

describe('retries and fallbacks inside a rerun', () => {
  it('counts the events of the chain they came from, and leaves the other chain alone', async () => {
    // Chain 0 holds its attempt. Chain 1 fails twice on the primary, then falls back and answers.
    const { llm, records } = setup(mock([held, serverError(), serverError()]), rerunAfter(30), {
      maxRetries: 1,
      fallback: { client: mock([ok('from backup')]), model: 'claude-x', name: 'backup' },
    });

    expect(await llm.call(call)).toBe('from backup');

    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      outcome: 'ok',
      provider: 'backup',
      attempts: 4,
      retries: 1,
      chains: 2,
      chain: 1,
      path: [
        { provider: 'primary', attempts: 2, outcome: 'error' },
        { provider: 'backup', attempts: 1, outcome: 'ok' },
      ],
    });
  });
});

describe('when every chain fails', () => {
  it('records the main chain and its error, without the message', async () => {
    const { llm, records } = setup(mock([serverError()]), rerunAtOnce);

    await expect(llm.call(call)).rejects.toThrow();

    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      outcome: 'error',
      attempts: 2,
      chains: 2,
      chain: 0,
      path: [{ provider: 'primary', attempts: 1, outcome: 'error' }],
    });
    expect(JSON.stringify(records()[0])).not.toContain('secret prompt text');
  });
});

describe('streams', () => {
  const chunks: WireStreamChunk[] = [
    { type: 'text-delta', delta: 'hel' },
    { type: 'text-delta', delta: 'lo' },
    { type: 'usage', usage: USAGE },
  ];

  it('times the first chunk of the kept stream from the start of the call', async () => {
    const sink = memorySink();
    const llm = new VernLLM({
      model: 'gpt-4o',
      maxRetries: 0,
      logger: 'silent',
      client: createMockStreamingClient([heldStream, chunks]).client,
      middleware: [rerunAfter(100), loggerMiddleware({ sink, logger: 'silent' })],
    });

    const stream = await llm.call(streamCall);
    for await (const chunk of stream.chunks) void chunk;
    await expect(stream.finalResult).resolves.toBe('hello');
    await sleep(0);

    const records = sink.entries.map(({ entry }) => entry as CallLogRecord);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: 'ok',
      streaming: true,
      attempts: 2,
      chains: 2,
      chain: 1,
    });
    // The user waited for the delay plus the second chain's first chunk, which came fast itself.
    expect(records[0]!.ttftMs!).toBeGreaterThanOrEqual(100);
    expect(records[0]!.attemptMs!).toBeLessThan(records[0]!.ttftMs! - 50);
  });
});
