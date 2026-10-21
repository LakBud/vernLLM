import { LLMError, VernLLM } from 'vern-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loggerMiddleware,
  memorySink,
  type CallLogRecord,
  type LoggerMiddlewareOptions,
  type SummaryEntry,
} from '../../src/index.js';
import { createMockClient, FakeApiError, sleep, textResponse } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

function setup(
  script: Parameters<typeof createMockClient>[0],
  options: LoggerMiddlewareOptions = {},
) {
  const sink = memorySink();
  const logger = loggerMiddleware({ sink, logger: 'silent', minSamples: 3, ...options });
  const llm = new VernLLM({
    client: createMockClient(script).client,
    model: 'gpt-4o',
    maxRetries: 0,
    logger: 'silent',
    middleware: [logger],
  });
  return { llm, logger, sink };
}

const kinds = (sink: ReturnType<typeof memorySink>) => sink.entries.map(({ entry }) => entry.kind);

afterEach(() => {
  vi.useRealTimers();
});

describe('slow calls', () => {
  it('raises a call over the threshold to warn and says why', async () => {
    const { llm, sink } = setup([async () => (await sleep(30), textResponse('ok'))], {
      slowCall: { thresholdMs: 10 },
    });

    await llm.call(call);

    expect(sink.entries[0]).toMatchObject({
      level: 'warn',
      entry: { outcome: 'ok', reason: 'slow' },
    });
  });

  it('leaves a fast call at info with no reason', async () => {
    const { llm, sink } = setup([textResponse('ok')], { slowCall: { thresholdMs: 5000 } });

    await llm.call(call);

    expect(sink.entries[0]!.level).toBe('info');
    expect(sink.entries[0]!.entry).not.toHaveProperty('reason');
  });

  it('flags a call above the live percentile of its series only after minSamples', async () => {
    let delay = 1;
    const { llm, sink } = setup([async () => (await sleep(delay), textResponse('ok'))], {
      slowCall: { aboveLivePercentile: 0.9 },
      minSamples: 5,
    });

    for (let i = 0; i < 12; i++) await llm.call(call);
    delay = 60;
    await llm.call(call);

    const records = sink.entries.map(({ entry }) => entry as CallLogRecord);
    expect(records.slice(0, 4).some((record) => record.reason === 'slow')).toBe(false);
    expect(records[12]!.reason).toBe('slow');
  });

  it('never calls a cache hit slow', async () => {
    const { llm, sink } = setup([async () => (await sleep(20), textResponse('ok'))], {
      slowCall: { thresholdMs: 1 },
    });
    const params = { cacheKey: 'k', ttl: 1000, call };

    await llm.cachedCall(params);
    sink.clear();
    await llm.cachedCall(params);

    expect(sink.entries[0]!.entry).not.toHaveProperty('reason');
  });
});

describe('sampling', () => {
  it('drops plain successes at rate 0 and keeps errors and slow calls', async () => {
    const { llm, sink, logger } = setup(
      [
        textResponse('fast'),
        async () => (await sleep(30), textResponse('slow')),
        new FakeApiError('down', 500),
      ],
      { sample: { success: 0 }, slowCall: { thresholdMs: 10 }, errorGrouping: false },
    );

    await llm.call(call);
    await llm.call(call);
    await llm.call(call).catch(() => {});

    expect(sink.entries.map(({ level }) => level)).toEqual(['warn', 'error']);
    // The stats saw all three calls, sampled out or not.
    expect(logger.stats.snapshot().series[0]).toMatchObject({ errors: 1 });
    expect(logger.stats.snapshot().series.find((s) => s.metric === 'durationMs')!.count).toBe(2);
  });

  it('keeps an aborted call at rate 0', async () => {
    const controller = new AbortController();
    const hangs = (_params: unknown, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
        controller.abort();
      });
    const { llm, sink } = setup([hangs], { sample: { success: 0 } });

    await llm.call({ ...call, signal: controller.signal }).catch(() => {});

    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]).toMatchObject({ level: 'info', entry: { outcome: 'aborted' } });
  });

  it('keeps a successful call that changed the breaker at rate 0', async () => {
    vi.useFakeTimers();
    const sink = memorySink();
    const llm = new VernLLM({
      client: createMockClient([new Error('down'), textResponse('ok')]).client,
      model: 'gpt-4o',
      maxRetries: 0,
      logger: 'silent',
      circuitBreaker: { threshold: 1, cooldownMs: 20 },
      middleware: [
        loggerMiddleware({ sink, logger: 'silent', sample: { success: 0 }, errorGrouping: false }),
      ],
    });

    await llm.call(call).catch(() => {});
    await vi.advanceTimersByTimeAsync(40);
    await llm.call(call);

    const records = sink.entries.map(({ entry }) => entry as CallLogRecord);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ outcome: 'ok' });
    expect(records[1]!.breaker?.length).toBeGreaterThan(0);
  });

  it('keeps about the requested share, and the same requests every time', async () => {
    const { llm, sink } = setup([textResponse('ok')], { sample: { success: 0.5 } });

    for (let i = 0; i < 200; i++) await llm.call(call);

    expect(sink.entries.length).toBeGreaterThan(60);
    expect(sink.entries.length).toBeLessThan(140);
  });
});

describe('error grouping', () => {
  it('writes the first error and one group entry for the rest, on dispose', async () => {
    const { llm, sink, logger } = setup([new FakeApiError('down', 500)]);

    for (let i = 0; i < 5; i++) await llm.call(call).catch(() => {});
    expect(kinds(sink)).toEqual(['call']);

    logger.dispose();

    expect(kinds(sink)).toEqual(['call', 'error_group']);
    expect(sink.entries[1]).toMatchObject({ level: 'error', entry: { count: 5, type: 'api' } });
  });

  it('passes every error through after dispose, since nothing would flush a group', async () => {
    const { llm, sink, logger } = setup([new FakeApiError('down', 500)]);
    logger.dispose();

    for (let i = 0; i < 3; i++) await llm.call(call).catch(() => {});

    expect(kinds(sink)).toEqual(['call', 'call', 'call']);
  });

  it('writes every error when grouping is off', async () => {
    const { llm, sink } = setup([new FakeApiError('down', 500)], { errorGrouping: false });

    for (let i = 0; i < 3; i++) await llm.call(call).catch(() => {});

    expect(kinds(sink)).toEqual(['call', 'call', 'call']);
  });

  it('never groups a rejection', async () => {
    const sink = memorySink();
    const llm = new VernLLM({
      client: createMockClient([textResponse('ok')]).client,
      model: 'gpt-4o',
      logger: 'silent',
      middleware: [
        {
          name: 'budget',
          wrap: async () => {
            throw new LLMError('over budget', 'quota_exceeded');
          },
        },
        loggerMiddleware({ sink, logger: 'silent' }),
      ],
    });

    for (let i = 0; i < 3; i++) await llm.call(call).catch(() => {});

    expect(sink.entries.map(({ level }) => level)).toEqual(['warn', 'warn', 'warn']);
  });
});

describe('the scheduler', () => {
  it('holds no timer until the first call, and none after dispose', async () => {
    vi.useFakeTimers();
    const { llm, logger } = setup([textResponse('ok')]);
    expect(vi.getTimerCount()).toBe(0);

    await llm.call(call);
    expect(vi.getTimerCount()).toBe(1);

    logger.dispose();
    expect(vi.getTimerCount()).toBe(0);

    await llm.call(call);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes an error group when its window closes', async () => {
    vi.useFakeTimers();
    const { llm, sink } = setup([new FakeApiError('down', 500)], {
      window: { durationMs: 2000, slots: 2 },
    });

    for (let i = 0; i < 3; i++) await llm.call(call).catch(() => {});
    expect(kinds(sink)).toEqual(['call']);

    await vi.advanceTimersByTimeAsync(2000);

    expect(kinds(sink)).toEqual(['call', 'error_group']);
  });

  it('emits a summary with an exemplar and hands it to onSummary', async () => {
    vi.useFakeTimers();
    const onSummary = vi.fn();
    const { llm, sink } = setup([textResponse('ok')], {
      window: { durationMs: 4000, slots: 4 },
      summary: { everyMs: 2000, onSummary },
    });

    for (let i = 0; i < 4; i++) await llm.call(call);
    await vi.advanceTimersByTimeAsync(2000);

    const summaries = sink.entries
      .filter(({ entry }) => entry.kind === 'summary')
      .map(({ entry }) => entry as SummaryEntry);
    const duration = summaries.find((entry) => entry.series.metric === 'durationMs')!;

    expect(duration.series.count).toBe(4);
    expect(duration.exemplar).toEqual({
      requestId: expect.any(String),
      durationMs: expect.any(Number),
    });
    expect(onSummary).toHaveBeenCalledTimes(1);
    expect(onSummary.mock.calls[0]![0]).toHaveLength(summaries.length);
  });

  it('emits a summary at a cadence shorter than a slot period', async () => {
    vi.useFakeTimers();
    const onSummary = vi.fn();
    const { llm } = setup([textResponse('ok')], { summary: { everyMs: 1000, onSummary } });

    await llm.call(call);
    await vi.advanceTimersByTimeAsync(3000);

    expect(onSummary.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('emits summaries without an onSummary callback', async () => {
    vi.useFakeTimers();
    const { llm, sink } = setup([textResponse('ok')], { summary: { everyMs: 1000 } });

    await llm.call(call);
    await vi.advanceTimersByTimeAsync(1000);

    expect(sink.entries.some(({ entry }) => entry.kind === 'summary')).toBe(true);
  });

  it('writes no summary while nothing was recorded', async () => {
    vi.useFakeTimers();
    const onSummary = vi.fn();
    const { llm, sink } = setup([textResponse('ok')], { summary: { everyMs: 1000, onSummary } });
    await llm.call(call);
    // Past the window, the call is gone, so there is nothing left to summarize.
    await vi.advanceTimersByTimeAsync(70_000);
    sink.clear();
    onSummary.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(onSummary).not.toHaveBeenCalled();
    expect(sink.entries).toHaveLength(0);
  });
});
