import { context, trace } from '@opentelemetry/api';
import { AlwaysOffSampler } from '@opentelemetry/sdk-trace-base';
import { LLMError } from 'vern-llm';
import { afterEach, describe, expect, it } from 'vitest';

import {
  byStart,
  createMetricHarness,
  createMockClient,
  createMockStreamingClient,
  createTraceHarness,
  describeOutcome,
  FakeApiError,
  histogramOf,
  installContextManager,
  maskRequestIds,
  parentIdOf,
  pointsOf,
  settleOutcome,
  sleep,
  spanId,
  textResponse,
} from '../helpers.js';

// The helpers are what every integration test stands on, so a wrong one would make a passing
// test meaningless. They are checked here directly.

const params = { model: 'm', max_tokens: 1, messages: [{ role: 'user' as const, content: 'hi' }] };
const options = { signal: new AbortController().signal };

describe('createMockClient', () => {
  it('plays the script in order and keeps reusing the last entry', async () => {
    const { client, calls } = createMockClient([textResponse('one'), textResponse('two')]);

    const texts: unknown[] = [];
    for (let index = 0; index < 4; index++) {
      const result = await client.chat.completions.create(params, options);
      texts.push(result.choices?.[0]?.message?.content);
    }

    expect(texts).toEqual(['one', 'two', 'two', 'two']);
    expect(calls).toHaveLength(4);
  });

  it('throws an error entry, and calls a function entry with the params and signal', async () => {
    const failure = new FakeApiError('boom', 503);
    const seen: unknown[] = [];
    const { client } = createMockClient([
      failure,
      async (given, signal) => {
        seen.push(given, signal);
        return textResponse('from a function');
      },
    ]);

    await expect(client.chat.completions.create(params, options)).rejects.toBe(failure);
    expect(failure.status).toBe(503);

    const result = await client.chat.completions.create(params, options);
    expect(result.choices?.[0]?.message?.content).toBe('from a function');
    expect(seen).toEqual([params, options.signal]);
  });

  it('refuses an empty script instead of inventing a response', async () => {
    const { client } = createMockClient([]);
    await expect(client.chat.completions.create(params, options)).rejects.toThrow(
      /script is empty/,
    );
  });

  it('builds a response with optional usage', () => {
    expect(textResponse('x').usage).toBeUndefined();
    expect(textResponse('x', { prompt_tokens: 1 }).usage).toEqual({ prompt_tokens: 1 });
  });
});

describe('createMockStreamingClient', () => {
  const read = async (iterable: AsyncIterable<unknown>) => {
    const seen: unknown[] = [];
    for await (const chunk of iterable) seen.push(chunk);
    return seen;
  };

  it('streams an array entry chunk by chunk and then ends', async () => {
    const chunks = [
      { type: 'text-delta' as const, delta: 'a' },
      { type: 'text-delta' as const, delta: 'b' },
    ];
    const { client, calls } = createMockStreamingClient([chunks]);

    expect(await read(client.chat.completions.createStream!(params, options))).toEqual(chunks);
    expect(calls).toHaveLength(1);
  });

  it('throws an error entry from the first read', async () => {
    const failure = new FakeApiError('cannot open', 500);
    const { client } = createMockStreamingClient([failure]);

    await expect(read(client.chat.completions.createStream!(params, options))).rejects.toBe(
      failure,
    );
  });

  it('uses a generator entry as it is', async () => {
    const { client } = createMockStreamingClient([
      async function* () {
        yield { type: 'text-delta' as const, delta: 'from a generator' };
      },
    ]);

    expect(await read(client.chat.completions.createStream!(params, options))).toEqual([
      { type: 'text-delta', delta: 'from a generator' },
    ]);
  });

  it('reuses the last entry once the script runs out', async () => {
    const { client } = createMockStreamingClient([[{ type: 'text-delta', delta: 'x' }]]);

    await read(client.chat.completions.createStream!(params, options));
    expect(await read(client.chat.completions.createStream!(params, options))).toHaveLength(1);
  });

  it('refuses an empty script, and a non streaming call to a streaming mock', async () => {
    const { client } = createMockStreamingClient([]);

    expect(() => client.chat.completions.createStream!(params, options)).toThrow(/script is empty/);
    await expect(client.chat.completions.create(params, options)).rejects.toThrow(/not scripted/);
  });
});

describe('metric harness', () => {
  it('collects what the meter recorded, by name, and flushes without error', async () => {
    const harness = createMetricHarness();
    harness.meter.createCounter('c').add(2, { k: 'v' });
    harness.meter.createHistogram('h').record(0.5);

    const collected = await harness.collect();
    expect([...collected.keys()].sort()).toEqual(['c', 'h']);

    await harness.provider.forceFlush();
    await harness.shutdown();
  });

  it('turns a metric into plain points, and an absent one into none', async () => {
    const harness = createMetricHarness();
    harness.meter.createCounter('c').add(3, { k: 'v' });
    harness.meter.createHistogram('h').record(4);
    const collected = await harness.collect();

    expect(pointsOf(collected.get('c'))).toEqual([{ attributes: { k: 'v' }, value: 3 }]);
    expect(histogramOf(pointsOf(collected.get('h'))[0]).sum).toBe(4);
    expect(pointsOf(undefined)).toEqual([]);

    await harness.shutdown();
  });

  it('histogramOf fails loudly for anything that is not a histogram point', () => {
    expect(() => histogramOf(undefined)).toThrow(/expected a histogram point/);
    expect(() => histogramOf({ attributes: {}, value: 1 })).toThrow(/expected a histogram point/);
  });
});

describe('trace harness', () => {
  it('reports ended spans and, separately, spans that never ended', async () => {
    const harness = createTraceHarness();
    const ended = harness.tracer.startSpan('ended');
    const open = harness.tracer.startSpan('open');
    ended.end();

    expect(harness.spans().map((span) => span.name)).toEqual(['ended']);
    expect(harness.openSpans()).toEqual(['open']);

    open.end();
    expect(harness.openSpans()).toEqual([]);

    await harness.provider.forceFlush();
    await harness.shutdown();
  });

  it('applies a sampler when given one', async () => {
    const harness = createTraceHarness({ sampler: new AlwaysOffSampler() });
    harness.tracer.startSpan('dropped').end();

    expect(harness.spans()).toEqual([]);
    await harness.shutdown();
  });
});

describe('span ordering and identity', () => {
  it('keeps a parent ahead of its child, and gives every span its own id', async () => {
    const harness = createTraceHarness();
    const parent = harness.tracer.startSpan('parent');
    const child = harness.tracer.startSpan('child', {}, trace.setSpan(context.active(), parent));
    child.end();
    parent.end();

    const spans = harness.spans();
    expect(byStart(spans).map((span) => span.name)).toEqual(['parent', 'child']);
    expect(new Set(spans.map(spanId)).size).toBe(2);
    await harness.shutdown();
  });

  it('sorts a same-instant pair the same way whichever order it arrives in', () => {
    const make = (name: string, id: string, parent?: string) =>
      ({
        name,
        startTime: [100, 5],
        spanContext: () => ({ spanId: id }),
        parentSpanContext: parent ? { spanId: parent } : undefined,
      }) as never;
    const parent = make('parent', 'p');
    const child = make('child', 'c', 'p');
    const unrelated = make('unrelated', 'u');

    expect(byStart([child, parent]).map((span: { name: string }) => span.name)).toEqual([
      'parent',
      'child',
    ]);
    expect(byStart([parent, child]).map((span: { name: string }) => span.name)).toEqual([
      'parent',
      'child',
    ]);
    expect(byStart([unrelated, parent]).map((span: { name: string }) => span.name)).toEqual([
      'unrelated',
      'parent',
    ]);
    expect(parentIdOf(child)).toBe('p');
    expect(parentIdOf(parent)).toBeUndefined();
  });
});

describe('context manager helper', () => {
  afterEach(() => {
    context.disable();
  });

  it('carries a context across an await, and is removed when asked', async () => {
    const restore = installContextManager();
    const harness = createTraceHarness();
    const span = harness.tracer.startSpan('active');

    await context.with(trace.setSpan(context.active(), span), async () => {
      await sleep(1);
      expect(trace.getSpan(context.active())).toBe(span);
    });

    restore();
    expect(trace.getSpan(context.active())).toBeUndefined();
    span.end();
    await harness.shutdown();
  });
});

describe('outcome helpers', () => {
  it('captures a value or an error without throwing', async () => {
    expect(await settleOutcome(Promise.resolve('ok'))).toEqual({ ok: true, value: 'ok' });

    const failure = new Error('bad');
    expect(await settleOutcome(Promise.reject(failure))).toEqual({ ok: false, error: failure });
  });

  it('describes what a caller can observe, and masks random request ids', () => {
    expect(
      describeOutcome({
        ok: true,
        value: { requestId: 'abc', text: 'x', nested: { requestId: 'def' } },
      }),
    ).toEqual({ ok: true, value: { requestId: '<id>', text: 'x', nested: { requestId: '<id>' } } });

    const error = new LLMError('the message', 'api', { code: 'server_error', status: 500 });
    expect(describeOutcome({ ok: false, error })).toEqual({
      ok: false,
      name: 'LLMError',
      type: 'api',
      code: 'server_error',
      status: 500,
      message: 'the message',
    });
  });

  it('masks ids only, and turns a value JSON cannot hold into null', () => {
    expect(maskRequestIds({ requestId: 'x', other: 'x' })).toEqual({
      requestId: '<id>',
      other: 'x',
    });
    expect(maskRequestIds(undefined)).toBeNull();
  });

  it('sleeps for at least the time asked', async () => {
    const started = performance.now();
    await sleep(20);
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
  });
});
