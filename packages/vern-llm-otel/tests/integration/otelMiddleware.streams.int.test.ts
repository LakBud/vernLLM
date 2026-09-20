import { SpanStatusCode } from '@opentelemetry/api';
import {
  VernLLM,
  type StreamCallResult,
  type VernLLMMiddleware,
  type WireStreamChunk,
} from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { otelMiddleware } from '../../src/otelMiddleware.js';
import {
  createMetricHarness,
  createMockStreamingClient,
  createTraceHarness,
  describeOutcome,
  FakeApiError,
  maskRequestIds,
  settleOutcome,
  sleep,
  type MetricHarness,
  type TraceHarness,
} from '../helpers.js';

// Each case runs twice, with and without the middleware. What a consumer can observe of the
// stream, its chunks, its errors, and how finalResult settles, must be identical, and neither run
// may raise an unhandled rejection the other does not.

const USAGE = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
const call = { userContent: 'hi', jsonMode: false as const, stream: true as const };

const okChunks: WireStreamChunk[] = [
  { type: 'text-delta', delta: 'hel' },
  { type: 'text-delta', delta: 'lo' },
  { type: 'usage', usage: USAGE },
];

type Script =
  ConstructorParameters<typeof Object> extends never
    ? never
    : Parameters<typeof createMockStreamingClient>[0];

type Stream = StreamCallResult<string>;

interface Case {
  name: string;
  script: Script;
  options?: { chunkIdleTimeoutMs?: number };
  consume(stream: Stream): Promise<Record<string, unknown>>;
  /** Status the call span should end with, or `undefined` when the stream never settles. */
  status: 'OK' | 'ERROR' | undefined;
}

/** How finalResult ended, or that it had not by the time the consumer was done. */
async function finalState(stream: Stream) {
  const state = await Promise.race([
    settleOutcome(stream.finalResult),
    sleep(150).then(() => 'pending' as const),
  ]);
  return state === 'pending' ? state : describeOutcome(state);
}

async function readAll(stream: Stream) {
  const seen: unknown[] = [];
  let iterationError: unknown;

  try {
    for await (const chunk of stream.chunks) seen.push(maskRequestIds(chunk));
  } catch (error) {
    iterationError = describeOutcome({ ok: false, error });
  }

  return { seen, iterationError, final: await finalState(stream) };
}

const failing = (): Script => [
  async function* () {
    yield { type: 'text-delta' as const, delta: 'partial' };
    throw new FakeApiError('stream broke: secret prompt text', 500);
  },
];

const cases: Case[] = [
  { name: 'full read', script: [okChunks], consume: readAll, status: 'OK' },
  {
    name: 'early break',
    script: [okChunks],
    consume: async (stream) => {
      const seen: unknown[] = [];
      for await (const chunk of stream.chunks) {
        seen.push(maskRequestIds(chunk));
        break;
      }
      return { seen, final: await finalState(stream) };
    },
    // Whatever the core does after a consumer walks away, both runs must do the same thing.
    status: undefined,
  },
  {
    name: 'consumer error',
    script: [okChunks],
    consume: async (stream) => {
      const seen: unknown[] = [];
      let consumerError: unknown;

      try {
        for await (const chunk of stream.chunks) {
          seen.push(maskRequestIds(chunk));
          throw new Error('the consumer failed, not the stream');
        }
      } catch (error) {
        consumerError = (error as Error).message;
      }

      return { seen, consumerError, final: await finalState(stream) };
    },
    status: undefined,
  },
  {
    name: 'never read, and never awaited',
    script: [okChunks],
    consume: async () => {
      await sleep(40);
      return { read: false };
    },
    status: 'OK',
  },
  { name: 'failure mid stream, read', script: failing(), consume: readAll, status: 'ERROR' },
  {
    name: 'failure mid stream, never read',
    script: failing(),
    consume: async () => {
      await sleep(40);
      return { read: false };
    },
    status: 'ERROR',
  },
  {
    name: 'idle timeout',
    script: [
      async function* () {
        yield { type: 'text-delta' as const, delta: 'partial' };
        // The core reports the idle timeout once the stalled read finally returns.
        await sleep(120);
        yield { type: 'text-delta' as const, delta: 'too late' };
      },
    ],
    options: { chunkIdleTimeoutMs: 25 },
    consume: readAll,
    status: 'ERROR',
  },
  {
    name: 'idle timeout, never read',
    script: [
      async function* () {
        yield { type: 'text-delta' as const, delta: 'partial' };
        await sleep(120);
      },
    ],
    options: { chunkIdleTimeoutMs: 25 },
    consume: async () => {
      await sleep(250);
      return { read: false };
    },
    status: 'ERROR',
  },
];

describe('stream transparency', () => {
  let trace: TraceHarness;
  let meter: MetricHarness;
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    trace = createTraceHarness();
    meter = createMetricHarness();
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(async () => {
    process.off('unhandledRejection', onUnhandled);
    await Promise.all([trace.shutdown(), meter.shutdown()]);
  });

  async function run(scenario: Case, middleware: VernLLMMiddleware[]) {
    const { client } = createMockStreamingClient(scenario.script);
    const llm = new VernLLM({
      model: 'gpt-4o',
      maxRetries: 0,
      logger: 'silent',
      client,
      middleware,
      ...scenario.options,
    });

    const stream = (await llm.call(call)) as Stream;
    const observed = await scenario.consume(stream);
    await sleep(30);

    return { observed, unhandled: [...unhandled] };
  }

  it.each(cases.map((scenario) => [scenario.name, scenario] as const))(
    '%s',
    async (_name, scenario) => {
      const baseline = await run(scenario, []);
      unhandled = [];

      const errors: unknown[] = [];
      const withOtel = await run(scenario, [
        otelMiddleware({
          tracer: trace.tracer,
          meter: meter.meter,
          logger: { debug: () => {}, warn: () => {}, error: (...args) => errors.push(args) },
        }),
      ]);

      // Same chunks, same errors, same finalResult outcome.
      expect(withOtel.observed).toEqual(baseline.observed);
      // No unhandled rejection that was not already there.
      expect(withOtel.unhandled).toEqual(baseline.unhandled);
      expect(withOtel.unhandled).toEqual([]);
      expect(errors).toEqual([]);

      if (scenario.status) {
        const callSpan = trace.spans().find((span) => span.name === 'vernllm.call');
        expect(callSpan?.status.code).toBe(
          scenario.status === 'OK' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
        );
        expect(callSpan?.attributes['vernllm.streaming']).toBe(true);
        expect(trace.openSpans()).toEqual([]);

        if (scenario.status === 'ERROR') {
          // The provider's message can echo a prompt, so only the low cardinality type is used.
          expect(callSpan?.status.message).not.toContain('secret');
        }
      }
    },
  );

  it('a stream that fails before its first chunk is an ordinary failed call', async () => {
    const { client } = createMockStreamingClient([new FakeApiError('cannot open', 500)]);
    const build = (middleware: VernLLMMiddleware[]) =>
      new VernLLM({ model: 'gpt-4o', maxRetries: 0, logger: 'silent', client, middleware });

    const baseline = describeOutcome(await settleOutcome(build([]).call(call)));
    const observed = describeOutcome(
      await settleOutcome(
        build([
          otelMiddleware({ tracer: trace.tracer, meter: meter.meter, logger: 'silent' }),
        ]).call(call),
      ),
    );

    expect(observed).toEqual(baseline);
    expect(observed.ok).toBe(false);
    expect(trace.openSpans()).toEqual([]);
    expect(trace.spans().find((span) => span.name === 'vernllm.call')?.status.code).toBe(
      SpanStatusCode.ERROR,
    );
  });

  it('returns the same stream object, with the same chunks iterable and final promise', async () => {
    const seenByCore: Stream[] = [];
    const spy: VernLLMMiddleware = {
      name: 'spy',
      wrap: async (_request, next) => {
        const result = await next();
        seenByCore.push(result.value as Stream);
        return result;
      },
    };
    const { client } = createMockStreamingClient([okChunks]);
    const llm = new VernLLM({
      model: 'gpt-4o',
      maxRetries: 0,
      logger: 'silent',
      client,
      // The spy sits inside the telemetry entry, so it sees what the core produced.
      middleware: [
        otelMiddleware({ tracer: trace.tracer, meter: meter.meter, logger: 'silent' }),
        spy,
      ],
    });

    const returned = (await llm.call(call)) as Stream;
    await returned.finalResult;

    expect(returned.chunks).toBe(seenByCore[0]!.chunks);
    expect(returned.finalResult).toBe(seenByCore[0]!.finalResult);
  });
});
