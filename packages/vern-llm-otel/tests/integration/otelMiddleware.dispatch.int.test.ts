import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  fromAnthropic,
  fromOpenAICompatible,
  LLMError,
  VernLLM,
  type Logger,
  type LLMClient,
  type WireStreamChunk,
} from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { otelMiddleware } from '../../src/otelMiddleware.js';
import {
  byStart,
  createMetricHarness,
  createMockClient,
  createMockStreamingClient,
  createTraceHarness,
  pointsOf,
  settleOutcome,
  textResponse,
  type MetricHarness,
  type TraceHarness,
} from '../helpers.js';

import type { OtelMiddlewareOptions } from '../../src/types/index.js';

const BASE = { maxRetries: 0, baseDelayMs: 1, logger: 'silent' as const };
const USAGE = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };

const lookupTool = {
  name: 'lookup',
  description: 'Looks something up',
  parameters: { type: 'object', properties: {} },
};

/** An OpenAI SDK shaped client that records what the adapter sent. */
function fakeOpenAI() {
  const create = vi.fn(async (_params: Record<string, unknown>) => ({
    choices: [{ message: { content: 'from openai' } }],
    usage: USAGE,
  }));
  return { sdk: { chat: { completions: { create } } }, create };
}

/** An Anthropic SDK shaped client. */
function fakeAnthropic(create: (...args: unknown[]) => unknown) {
  return { messages: { create: vi.fn(create) } } as unknown as Parameters<typeof fromAnthropic>[0];
}

describe('attempt spans follow the provider request', () => {
  let trace: TraceHarness;
  let meter: MetricHarness;
  let errorLog: ReturnType<typeof vi.fn<Logger['error']>>;
  let logger: Logger;

  beforeEach(() => {
    trace = createTraceHarness();
    meter = createMetricHarness();
    errorLog = vi.fn<Logger['error']>();
    logger = { debug: () => {}, warn: () => {}, error: errorLog };
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all([trace.shutdown(), meter.shutdown()]);
  });

  const otel = (options: OtelMiddlewareOptions = {}) =>
    otelMiddleware({ tracer: trace.tracer, meter: meter.meter, logger, ...options });

  const spans = () => byStart(trace.spans());
  const named = (name: string) => spans().filter((span) => span.name === name);
  const clientSpans = () => spans().filter((span) => span.kind === SpanKind.CLIENT);
  const pointCount = async (metric: string) =>
    pointsOf((await meter.collect()).get(metric)).reduce(
      (sum, point) => sum + (typeof point.value === 'number' ? 1 : point.value.count),
      0,
    );

  describe('a request the adapter rejects before sending it', () => {
    it('leaves no attempt span and no duration when GPT-6 is asked for tools and reasoning', async () => {
      const { sdk, create } = fakeOpenAI();
      const llm = new VernLLM({
        ...BASE,
        client: fromOpenAICompatible(sdk as never),
        model: 'gpt-6-sol',
        middleware: [otel()],
      });

      const outcome = await settleOutcome(
        llm.call({
          userContent: 'hi',
          jsonMode: false,
          tools: [lookupTool],
          reasoningEffort: 'high',
        } as never),
      );

      expect(outcome.ok).toBe(false);
      expect((outcome as { error: LLMError }).error.code).toBe('unsupported_capability');
      expect(create).not.toHaveBeenCalled();

      expect(clientSpans()).toEqual([]);
      const [callSpan] = named('vernllm.call');
      expect(callSpan!.status.code).toBe(SpanStatusCode.ERROR);
      expect(callSpan!.attributes['error.type']).toBe('unsupported_capability');
      expect(callSpan!.attributes['vernllm.total_attempts']).toBe(0);

      expect(await pointCount('gen_ai.client.operation.duration')).toBe(0);
      expect(trace.openSpans()).toEqual([]);
      expect(errorLog).not.toHaveBeenCalled();
    });

    it('records only the fallback when a Claude model rejects a forced tool choice', async () => {
      const anthropicCreate = vi.fn();
      const { sdk: openai } = fakeOpenAI();
      const llm = new VernLLM({
        ...BASE,
        client: fromAnthropic(fakeAnthropic(anthropicCreate)),
        model: 'claude-opus-5-5',
        fallback: { client: fromOpenAICompatible(openai as never), model: 'gpt-4o' },
        middleware: [otel()],
      });

      await llm.call({
        userContent: 'hi',
        jsonMode: false,
        tools: [lookupTool],
        toolChoice: 'required',
      } as never);

      expect(anthropicCreate).not.toHaveBeenCalled();
      expect(clientSpans().map((span) => span.name)).toEqual(['chat gpt-4o']);
      expect(clientSpans()[0]!.status.code).toBe(SpanStatusCode.OK);

      const [callSpan] = named('vernllm.call');
      expect(callSpan!.attributes['vernllm.total_attempts']).toBe(1);
      expect(callSpan!.events.map((event) => event.name)).toEqual(['vernllm.fallback']);

      const [duration] = pointsOf((await meter.collect()).get('gen_ai.client.operation.duration'));
      expect(duration!.attributes['gen_ai.request.model']).toBe('gpt-4o');
      expect(await pointCount('gen_ai.client.operation.duration')).toBe(1);
    });

    it('records no reasoning level when GPT-6 tools are sent with reasoning_effort "none"', async () => {
      const { sdk, create } = fakeOpenAI();
      const llm = new VernLLM({
        ...BASE,
        client: fromOpenAICompatible(sdk as never),
        model: 'gpt-6-sol',
        middleware: [otel()],
      });

      await llm.call({ userContent: 'hi', jsonMode: false, tools: [lookupTool] } as never);

      // The adapter adds "none" itself, which turns reasoning off, so no span claims a level.
      expect(create.mock.calls[0]![0].reasoning_effort).toBe('none');
      const [attempt] = clientSpans();
      expect(attempt!.attributes).not.toHaveProperty('gen_ai.request.reasoning.level');
      expect(attempt!.attributes).not.toHaveProperty('vernllm.request.reasoning_effort');
    });
  });

  describe('a call rejected before dispatch', () => {
    it('leaves no attempt span when the rate limiter queue is full', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const client = createMockClient([
        async () => {
          await held;
          return textResponse('ok', USAGE);
        },
      ]).client;
      const llm = new VernLLM({
        ...BASE,
        client,
        model: 'gpt-4o',
        rateLimit: { maxConcurrent: 1, maxQueueSize: 1 },
        middleware: [otel()],
      });

      // One call holds the only slot and one waits in the queue, so a third has nowhere to go.
      const running = llm.call({ userContent: 'a', jsonMode: false });
      const queued = llm.call({ userContent: 'b', jsonMode: false });
      const rejected = await settleOutcome(llm.call({ userContent: 'c', jsonMode: false }));
      release();
      await Promise.all([running, queued]);

      expect((rejected as { error: LLMError }).error.code).toBe('rate_limit_queue_full');
      expect(clientSpans()).toHaveLength(2);
      expect(named('vernllm.call')).toHaveLength(3);
      expect(await pointCount('gen_ai.client.operation.duration')).toBe(2);
    });

    it('leaves no attempt span when a transform throws', async () => {
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([textResponse('ok', USAGE)]).client,
        model: 'gpt-4o',
        middleware: [
          otel(),
          {
            name: 'broken',
            transform: () => {
              throw new Error('transform broke');
            },
          },
        ],
      });

      const outcome = await settleOutcome(llm.call({ userContent: 'hi', jsonMode: false }));

      expect(outcome.ok).toBe(false);
      expect(clientSpans()).toEqual([]);
      expect(named('vernllm.call')[0]!.status.code).toBe(SpanStatusCode.ERROR);
      expect(await pointCount('gen_ai.client.operation.duration')).toBe(0);
    });
  });

  describe('gen_ai.provider.name', () => {
    const namedClient = (provider: string): LLMClient => ({
      ...createMockClient([textResponse('ok', USAGE)]).client,
      adapter: { name: 'openai-compatible', provider },
    });

    it('comes from the adapter when it names the provider', async () => {
      // A model id that would otherwise be guessed as OpenAI.
      const llm = new VernLLM({
        ...BASE,
        client: namedClient('groq'),
        model: 'gpt-oss-120b',
        middleware: [otel()],
      });

      await llm.call({ userContent: 'hi', jsonMode: false });

      expect(clientSpans()[0]!.attributes['gen_ai.provider.name']).toBe('groq');
      const collected = await meter.collect();
      for (const metric of ['gen_ai.client.operation.duration', 'gen_ai.client.token.usage']) {
        for (const point of pointsOf(collected.get(metric))) {
          expect(point.attributes['gen_ai.provider.name']).toBe('groq');
        }
      }
    });

    it('still gives way to providerNames', async () => {
      const llm = new VernLLM({
        ...BASE,
        client: namedClient('groq'),
        model: 'gpt-oss-120b',
        middleware: [otel({ providerNames: { primary: 'azure.ai.openai' } })],
      });

      await llm.call({ userContent: 'hi', jsonMode: false });

      expect(clientSpans()[0]!.attributes['gen_ai.provider.name']).toBe('azure.ai.openai');
    });

    it('falls back to the model id when the adapter names no provider', async () => {
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([textResponse('ok', USAGE)]).client,
        model: 'claude-sonnet-5',
        middleware: [otel()],
      });

      await llm.call({ userContent: 'hi', jsonMode: false });

      expect(clientSpans()[0]!.attributes['gen_ai.provider.name']).toBe('anthropic');
    });
  });

  describe('time to first chunk', () => {
    const reasoningEvents = () => [
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'a' } },
      'wait',
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'b' } },
      'wait',
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 's' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      'wait',
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ];

    /** Streams Claude reasoning, whose deltas the adapter turns into pings, 200ms apart. */
    function reasoningStream() {
      return async function* () {
        for (const event of reasoningEvents()) {
          if (event === 'wait') await new Promise((resolve) => setTimeout(resolve, 200));
          else yield event;
        }
      };
    }

    async function streamed(client: LLMClient, model: string) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
      const llm = new VernLLM({ ...BASE, client, model, middleware: [otel()] });

      const pending = llm.call({ userContent: 'hi', jsonMode: false, stream: true });
      await vi.advanceTimersByTimeAsync(1000);
      const { chunks, finalResult } = await pending;
      for await (const _chunk of chunks) {
        // drained
      }
      await finalResult;
      vi.useRealTimers();
    }

    it('skips the pings Claude reasoning sends, and times the first text', async () => {
      const client = fromAnthropic(fakeAnthropic(async () => reasoningStream()()));

      await streamed(client, 'claude-opus-5-5');

      const [attempt] = clientSpans();
      // Three 200ms waits before the first text chunk; the pings came after 0ms and 200ms.
      expect(attempt!.attributes['gen_ai.response.time_to_first_chunk']).toBe(0.6);
      expect(attempt!.attributes['gen_ai.request.stream']).toBe(true);

      const [point] = pointsOf(
        (await meter.collect()).get('gen_ai.client.operation.time_to_first_chunk'),
      );
      expect((point!.value as { sum: number; count: number }).sum).toBe(0.6);
      expect((point!.value as { count: number }).count).toBe(1);
    });

    it('times the attempt that answered when an earlier one failed after a ping', async () => {
      const { client } = createMockStreamingClient([
        async function* () {
          yield { type: 'ping' as const };
          await new Promise((resolve) => setTimeout(resolve, 100));
          throw Object.assign(new Error('overloaded'), { status: 503 });
        },
        async function* (): AsyncGenerator<WireStreamChunk> {
          await new Promise((resolve) => setTimeout(resolve, 300));
          yield { type: 'text-delta', delta: 'ok' };
          yield { type: 'usage', usage: USAGE };
        },
      ]);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
      const llm = new VernLLM({
        ...BASE,
        maxRetries: 1,
        client,
        model: 'gpt-4o',
        middleware: [otel()],
      });

      const pending = llm.call({ userContent: 'hi', jsonMode: false, stream: true });
      await vi.advanceTimersByTimeAsync(1000);
      const { chunks, finalResult } = await pending;
      for await (const _chunk of chunks) {
        // drained
      }
      await finalResult;
      vi.useRealTimers();

      const [failed, answered] = clientSpans();
      expect(failed!.status.code).toBe(SpanStatusCode.ERROR);
      expect(failed!.attributes).not.toHaveProperty('gen_ai.response.time_to_first_chunk');
      expect(answered!.attributes['gen_ai.response.time_to_first_chunk']).toBe(0.3);
      expect(await pointCount('gen_ai.client.operation.time_to_first_chunk')).toBe(1);
    });
  });

  describe('a stream the consumer stops early', () => {
    it('ends its spans as aborted, not as a provider failure', async () => {
      const { client } = createMockStreamingClient([
        async function* (): AsyncGenerator<WireStreamChunk> {
          yield { type: 'text-delta', delta: 'one' };
          yield { type: 'text-delta', delta: 'two' };
          await new Promise((resolve) => setTimeout(resolve, 50));
          yield { type: 'text-delta', delta: 'three' };
          yield { type: 'usage', usage: USAGE };
        },
      ]);
      const llm = new VernLLM({ ...BASE, client, model: 'gpt-4o', middleware: [otel()] });

      const { chunks, finalResult } = await llm.call({
        userContent: 'hi',
        jsonMode: false,
        stream: true,
      });
      for await (const _chunk of chunks) break;
      const outcome = await settleOutcome(finalResult);

      expect((outcome as { error: LLMError }).error.type).toBe('aborted');
      const [callSpan] = named('vernllm.call');
      const [attempt] = clientSpans();
      for (const span of [callSpan!, attempt!]) {
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
        expect(span.attributes['error.type']).toBe('aborted');
      }
      expect(trace.openSpans()).toEqual([]);

      const [duration] = pointsOf((await meter.collect()).get('gen_ai.client.operation.duration'));
      expect(duration!.attributes['error.type']).toBe('aborted');
    });
  });

  describe('a circuit that changes state outside any call', () => {
    it('is counted, with no span and no error', async () => {
      const llm = new VernLLM({
        ...BASE,
        client: createMockClient([textResponse('ok', USAGE)]).client,
        model: 'gpt-4o',
        circuitBreaker: true,
        middleware: [otel()],
      });

      llm.openCircuit();
      llm.closeCircuit();

      const transitions = pointsOf((await meter.collect()).get('vernllm.circuit.transitions'));
      expect(
        transitions.map((point) => [
          point.attributes['vernllm.circuit.from'],
          point.attributes['vernllm.circuit.to'],
          point.value,
        ]),
      ).toEqual([
        ['closed', 'open', 1],
        ['open', 'closed', 1],
      ]);
      expect(transitions[0]!.attributes['vernllm.provider']).toBe('primary');
      expect(trace.spans()).toEqual([]);
      expect(errorLog).not.toHaveBeenCalled();
    });
  });
});
