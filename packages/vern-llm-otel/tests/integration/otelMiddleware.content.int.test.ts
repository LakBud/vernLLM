import { AlwaysOffSampler } from '@opentelemetry/sdk-trace-base';
import {
  createMiddlewareRef,
  requireRef,
  VernLLM,
  type Logger,
  type VernLLMMiddleware,
} from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { otelMiddleware } from '../../src/otelMiddleware.js';
import {
  byStart,
  createMetricHarness,
  createMockClient,
  createMockStreamingClient,
  createTraceHarness,
  FakeApiError,
  installContextManager,
  textResponse,
  type MetricHarness,
  type TraceHarness,
} from '../helpers.js';

import type { OtelMiddlewareOptions } from '../../src/types/index.js';

const BASE = { model: 'gpt-4o', maxRetries: 0, baseDelayMs: 1, logger: 'silent' as const };
const USAGE = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
const CONTENT_KEYS = [
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
];

describe('content capture end to end', () => {
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
    await Promise.all([trace.shutdown(), meter.shutdown()]);
  });

  const otel = (options: OtelMiddlewareOptions = {}) =>
    otelMiddleware({ tracer: trace.tracer, meter: meter.meter, logger, ...options });

  const spans = () => byStart(trace.spans());
  const callSpans = () => spans().filter((span) => span.name === 'vernllm.call');
  const attemptSpans = () => spans().filter((span) => span.name.startsWith('chat '));
  const parsed = (value: unknown) => JSON.parse(String(value)) as unknown;
  const hasContent = (span: { attributes: Record<string, unknown> }) =>
    CONTENT_KEYS.filter((key) => key in span.attributes);

  it('records nothing unless capture is configured', async () => {
    const client = createMockClient([textResponse('answer', USAGE)]).client;
    const llm = new VernLLM({ ...BASE, client, middleware: [otel()] });

    await llm.call({ userContent: 'hi', systemPrompt: 'be brief', jsonMode: false });

    for (const span of spans()) expect(hasContent(span)).toEqual([]);
    expect(callSpans()[0]!.attributes).not.toHaveProperty('vernllm.content.captured');
  });

  it('puts input and output on the answering attempt span, and never on the call span', async () => {
    const client = createMockClient([textResponse('the answer', USAGE)]).client;
    const llm = new VernLLM({ ...BASE, client, middleware: [otel({ captureContent: true })] });

    await llm.call({ userContent: 'the question', systemPrompt: 'be brief', jsonMode: false });

    const [attempt] = attemptSpans();
    expect(parsed(attempt!.attributes['gen_ai.system_instructions'])).toEqual([
      { type: 'text', content: 'be brief' },
    ]);
    expect(parsed(attempt!.attributes['gen_ai.input.messages'])).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'the question' }] },
    ]);
    expect(parsed(attempt!.attributes['gen_ai.output.messages'])).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'the answer' }],
        finish_reason: 'stop',
      },
    ]);
    // The output was written after the usage event, so the span must still have been open.
    expect(attempt!.attributes['gen_ai.usage.output_tokens']).toBe(4);

    expect(hasContent(callSpans()[0]!)).toEqual([]);
    expect(callSpans()[0]!.attributes['vernllm.content.captured']).toBe(true);
  });

  it('records what each attempt actually sent, and output only for the one that answered', async () => {
    const client = createMockClient([
      new FakeApiError('down', 500),
      textResponse('ok', USAGE),
    ]).client;
    const stamp: VernLLMMiddleware = {
      name: 'stamp',
      transform: (_request, ctx) => ({
        addMessages: [{ role: 'user', content: `attempt ${ctx.attempt}` }],
      }),
    };
    const llm = new VernLLM({
      ...BASE,
      maxRetries: 1,
      client,
      middleware: [stamp, otel({ captureContent: true })],
    });

    await llm.call({ userContent: 'hi', jsonMode: false });

    const [first, second] = attemptSpans();
    const lastText = (span: typeof first) =>
      (parsed(span!.attributes['gen_ai.input.messages']) as { parts: { content: string }[] }[]).at(
        -1,
      )!.parts[0]!.content;

    expect(lastText(first)).toBe('attempt 1');
    expect(lastText(second)).toBe('attempt 2');
    expect(first!.attributes).not.toHaveProperty('gen_ai.output.messages');
    expect(second!.attributes).toHaveProperty('gen_ai.output.messages');
  });

  it('records the output of a stream when it settles', async () => {
    const { client } = createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'hel' },
        { type: 'text-delta', delta: 'lo' },
        { type: 'usage', usage: USAGE },
      ],
    ]);
    const llm = new VernLLM({ ...BASE, client, middleware: [otel({ captureContent: true })] });

    const { chunks, finalResult } = await llm.call({
      userContent: 'hi',
      jsonMode: false,
      stream: true,
    });
    for await (const chunk of chunks) void chunk;
    await finalResult;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const [attempt] = attemptSpans();
    expect(parsed(attempt!.attributes['gen_ai.output.messages'])).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'hello' }], finish_reason: 'stop' },
    ]);
  });

  it('records no content for a call that failed', async () => {
    const client = createMockClient([new FakeApiError('down', 500)]).client;
    const llm = new VernLLM({ ...BASE, client, middleware: [otel({ captureContent: true })] });

    await expect(llm.call({ userContent: 'hi', jsonMode: false })).rejects.toThrow();

    const [attempt] = attemptSpans();
    expect(attempt!.attributes).toHaveProperty('gen_ai.input.messages');
    expect(attempt!.attributes).not.toHaveProperty('gen_ai.output.messages');
  });

  it('records no content for a cache hit, whatever the gate says', async () => {
    const client = createMockClient([textResponse('cached', USAGE)]).client;
    const llm = new VernLLM({ ...BASE, client, middleware: [otel({ captureContent: true })] });
    const params = {
      cacheKey: 'k',
      ttl: 10_000,
      call: { userContent: 'hi', jsonMode: false as const },
    };

    await llm.cachedCall(params);
    await llm.cachedCall(params);

    const [, hit] = callSpans();
    expect(hit!.attributes['vernllm.no_attempt.reason']).toBe('cache_hit');
    expect(hasContent(hit!)).toEqual([]);
    expect(attemptSpans()).toHaveLength(1);
  });

  describe('gating with when', () => {
    it('a false decision records no content and never calls redact', async () => {
      const redact = vi.fn((text: string) => text);
      const client = createMockClient([textResponse('answer', USAGE)]).client;
      const llm = new VernLLM({
        ...BASE,
        client,
        middleware: [otel({ captureContent: { when: () => false, redact } })],
      });

      await llm.call({ userContent: 'hi', jsonMode: false });

      expect(redact).not.toHaveBeenCalled();
      for (const span of spans()) expect(hasContent(span)).toEqual([]);
      expect(callSpans()[0]!.attributes['vernllm.content.captured']).toBe(false);
    });

    it('is evaluated once per call however many attempts it makes', async () => {
      const when = vi.fn(() => true);
      const primary = createMockClient([new FakeApiError('down', 500)]).client;
      const backup = createMockClient([textResponse('ok', USAGE)]).client;
      const llm = new VernLLM({
        ...BASE,
        maxRetries: 1,
        client: primary,
        fallback: { client: backup, model: 'claude-x' },
        middleware: [otel({ captureContent: { when } })],
      });

      await llm.call({ userContent: 'hi', jsonMode: false });

      expect(attemptSpans()).toHaveLength(3);
      expect(when).toHaveBeenCalledTimes(1);
      expect(attemptSpans().every((span) => 'gen_ai.input.messages' in span.attributes)).toBe(true);
    });

    it('is evaluated once for a streaming call', async () => {
      const when = vi.fn(() => true);
      const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'a' }]]);
      const llm = new VernLLM({
        ...BASE,
        client,
        middleware: [otel({ captureContent: { when } })],
      });

      const { finalResult } = await llm.call({ userContent: 'hi', jsonMode: false, stream: true });
      await finalResult;

      expect(when).toHaveBeenCalledTimes(1);
    });

    it('a throwing gate fails closed and is logged once', async () => {
      const client = createMockClient([textResponse('answer', USAGE)]).client;
      const llm = new VernLLM({
        ...BASE,
        client,
        middleware: [
          otel({
            captureContent: {
              when: () => {
                throw new Error('policy down');
              },
            },
          }),
        ],
      });

      await expect(llm.call({ userContent: 'hi', jsonMode: false })).resolves.toBe('answer');

      for (const span of spans()) expect(hasContent(span)).toEqual([]);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog.mock.calls[0]![0]).toBe('[VernLLM] otel: captureContent.when failed');
    });

    it('a promise returning gate fails closed and is logged once', async () => {
      const client = createMockClient([textResponse('answer', USAGE)]).client;
      const llm = new VernLLM({
        ...BASE,
        client,
        middleware: [otel({ captureContent: { when: (() => Promise.resolve(true)) as never } })],
      });

      await llm.call({ userContent: 'hi', jsonMode: false });

      for (const span of spans()) expect(hasContent(span)).toEqual([]);
      expect(errorLog).toHaveBeenCalledTimes(1);
    });

    it('a truthy non boolean means no capture', async () => {
      const client = createMockClient([textResponse('answer', USAGE)]).client;
      const llm = new VernLLM({
        ...BASE,
        client,
        middleware: [otel({ captureContent: { when: (() => 'yes') as never } })],
      });

      await llm.call({ userContent: 'hi', jsonMode: false });

      for (const span of spans()) expect(hasContent(span)).toEqual([]);
      expect(errorLog).not.toHaveBeenCalled();
    });

    it('is not called at all when the call span is not sampled', async () => {
      const off = createTraceHarness({ sampler: new AlwaysOffSampler() });
      const when = vi.fn(() => true);
      const client = createMockClient([textResponse('answer', USAGE)]).client;
      const llm = new VernLLM({
        ...BASE,
        client,
        middleware: [
          otelMiddleware({
            tracer: off.tracer,
            meter: meter.meter,
            logger,
            captureContent: { when },
          }),
        ],
      });

      await expect(llm.call({ userContent: 'hi', jsonMode: false })).resolves.toBe('answer');

      expect(when).not.toHaveBeenCalled();
      expect(off.spans()).toEqual([]);
      await off.shutdown();
    });
  });

  describe('redaction ordering', () => {
    const redaction = createMiddlewareRef('redaction');
    const redactor: VernLLMMiddleware = {
      name: 'redaction',
      ref: redaction,
      transform: (request) => ({
        messages: request.messages.map((message) =>
          message.role === 'user' && typeof message.content === 'string'
            ? { ...message, content: message.content.replaceAll('SECRET', '***') }
            : message,
        ),
      }),
    };

    const run = async (options: OtelMiddlewareOptions) => {
      const client = createMockClient([textResponse('ok', USAGE)]).client;
      const llm = new VernLLM({ ...BASE, client, middleware: [redactor, otel(options)] });
      await llm.call({ userContent: 'my SECRET question', jsonMode: false });
      return String(attemptSpans()[0]!.attributes['gen_ai.input.messages']);
    };

    it('sees redacted text by default, because capture runs after other transforms', async () => {
      const input = await run({ captureContent: true });

      expect(input).toContain('my *** question');
      expect(input).not.toContain('SECRET');
    });

    it('sees redacted text with an explicit runsAfter', async () => {
      const input = await run({ captureContent: true, runsAfter: [redaction] });

      expect(input).toContain('my *** question');
      expect(input).not.toContain('SECRET');
    });

    it('still sees redacted text when runsAfter holds a ref that matches nothing', async () => {
      // The core drops an unresolved bare ref with a warning, so the order must not depend on it.
      const stranger = createMiddlewareRef('redaction');
      const input = await run({ captureContent: true, runsAfter: [stranger] });

      expect(input).toContain('my *** question');
      expect(input).not.toContain('SECRET');
    });

    it('still sees redacted text with an explicit low priority and a required ref', async () => {
      const input = await run({
        captureContent: true,
        priority: -1000,
        runsAfter: [requireRef(redaction)],
      });

      expect(input).toContain('my *** question');
      expect(input).not.toContain('SECRET');
    });
  });

  describe('call span position', () => {
    // Another outermost entry that opens its own span, so nesting shows which one is outside.
    const redaction = createMiddlewareRef('redaction');
    let restore: () => void;

    beforeEach(() => {
      restore = installContextManager();
    });
    afterEach(() => {
      restore();
    });

    const outer = () =>
      ({
        name: 'other',
        position: 'outermost',
        priority: 0,
        wrap: (_request, next) =>
          trace.tracer.startActiveSpan('other', async (span) => {
            try {
              return await next();
            } finally {
              span.end();
            }
          }),
      }) satisfies VernLLMMiddleware;

    const run = async (options: OtelMiddlewareOptions) => {
      const client = createMockClient([textResponse('ok', USAGE)]).client;
      const marker: VernLLMMiddleware = { name: 'redaction', ref: redaction };
      const llm = new VernLLM({ ...BASE, client, middleware: [marker, outer(), otel(options)] });
      await llm.call({ userContent: 'hi', jsonMode: false });

      const other = spans().find((span) => span.name === 'other')!;
      const call = callSpans()[0]!;
      return { other, call };
    };

    it('wraps the other entry when capture is off', async () => {
      const { other, call } = await run({});
      expect(call.parentSpanContext).toBeUndefined();
      expect(other.parentSpanContext?.spanId).toBe(call.spanContext().spanId);
    });

    it('sits inside another outermost entry when capture is on, so capture runs last', async () => {
      const { other, call } = await run({ captureContent: true });
      expect(other.parentSpanContext).toBeUndefined();
      expect(call.parentSpanContext?.spanId).toBe(other.spanContext().spanId);
    });

    it('does not change that with runsAfter alone', async () => {
      const { other, call } = await run({ captureContent: true, runsAfter: [redaction] });
      expect(other.parentSpanContext).toBeUndefined();
      expect(call.parentSpanContext?.spanId).toBe(other.spanContext().spanId);
    });

    it('wraps it again once the priority is set explicitly', async () => {
      const { other, call } = await run({
        captureContent: true,
        priority: -1000,
        runsAfter: [requireRef(redaction)],
      });
      expect(call.parentSpanContext).toBeUndefined();
      expect(other.parentSpanContext?.spanId).toBe(call.spanContext().spanId);
    });

    it('is outside a middleware that is not outermost, with capture on', async () => {
      const inner: VernLLMMiddleware = {
        name: 'inner',
        priority: -5000,
        wrap: (_request, next) =>
          trace.tracer.startActiveSpan('inner', async (span) => {
            try {
              return await next();
            } finally {
              span.end();
            }
          }),
      };
      const client = createMockClient([textResponse('ok', USAGE)]).client;
      const llm = new VernLLM({
        ...BASE,
        client,
        middleware: [inner, otel({ captureContent: true })],
      });
      await llm.call({ userContent: 'hi', jsonMode: false });

      const innerSpan = spans().find((span) => span.name === 'inner')!;
      expect(callSpans()[0]!.parentSpanContext).toBeUndefined();
      expect(innerSpan.parentSpanContext?.spanId).toBe(callSpans()[0]!.spanContext().spanId);
    });
  });
});
