import { VernLLM, type WireStreamChunk } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { loggerMiddleware, memorySink, type CallLogRecord } from '../../src/index.js';
import { createMockStreamingClient, FakeApiError, maskRequestIds, sleep } from '../helpers.js';

const USAGE = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
const call = { userContent: 'hi', jsonMode: false as const, stream: true as const };
const okChunks: WireStreamChunk[] = [
  { type: 'text-delta', delta: 'hel' },
  { type: 'text-delta', delta: 'lo' },
  { type: 'usage', usage: USAGE },
];

function setup(script: Parameters<typeof createMockStreamingClient>[0], withLogger = true) {
  const sink = memorySink();
  const llm = new VernLLM({
    client: createMockStreamingClient(script).client,
    model: 'gpt-4o',
    maxRetries: 0,
    logger: 'silent',
    middleware: withLogger ? [loggerMiddleware({ sink, logger: 'silent' })] : [],
  });
  return { llm, records: () => sink.entries.map(({ entry }) => entry as CallLogRecord) };
}

describe('streams', () => {
  it('writes one record when finalResult settles, not when the stream is returned', async () => {
    const { llm, records } = setup([okChunks]);

    const stream = await llm.call(call);
    expect(records()).toHaveLength(0);

    for await (const chunk of stream.chunks) void chunk;
    await expect(stream.finalResult).resolves.toBe('hello');
    await sleep(0);

    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      outcome: 'ok',
      streaming: true,
      attempts: 1,
      provider: 'primary',
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    });
    expect(records()[0]!.ttftMs).toBeGreaterThanOrEqual(0);
    expect(records()[0]!.durationMs).toBeGreaterThanOrEqual(records()[0]!.ttftMs!);
  });

  it('records a stream that breaks midway as an error, without its message', async () => {
    const { llm, records } = setup([
      async function* () {
        yield { type: 'text-delta' as const, delta: 'partial' };
        throw new FakeApiError('stream broke: secret prompt text', 500);
      },
    ]);

    const stream = await llm.call(call);
    await stream.finalResult.catch(() => {});
    await sleep(0);

    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ outcome: 'error', streaming: true, level: 'error' });
    expect(JSON.stringify(records()[0])).not.toContain('secret prompt text');
  });

  it('leaves what the consumer sees unchanged', async () => {
    const seen = async (withLogger: boolean) => {
      const { llm } = setup([okChunks], withLogger);
      const stream = await llm.call(call);
      const chunks: unknown[] = [];
      for await (const chunk of stream.chunks) chunks.push(maskRequestIds(chunk));
      return { chunks, final: maskRequestIds(await stream.finalResult) };
    };

    expect(await seen(true)).toEqual(await seen(false));
  });

  it('does not raise an unhandled rejection when a stream nobody awaits fails', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);

    try {
      const { llm } = setup([new FakeApiError('boom', 500)]);
      await llm.call(call).then(
        (stream) => stream.finalResult.catch(() => {}),
        () => {},
      );
      await sleep(20);
    } finally {
      process.off('unhandledRejection', listener);
    }

    expect(unhandled).toEqual([]);
  });

  it('measures the first token from the content, not from a keep alive ping before it', async () => {
    const { llm, records } = setup([[{ type: 'ping' }, ...okChunks]]);

    const stream = await llm.call(call);
    for await (const chunk of stream.chunks) void chunk;
    await stream.finalResult;
    await sleep(0);

    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ outcome: 'ok', streaming: true, attempts: 1 });
    expect(records()[0]!.ttftMs).toBeLessThanOrEqual(records()[0]!.durationMs);
  });
});
