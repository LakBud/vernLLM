import { SpanStatusCode } from '@opentelemetry/api';
import { VernLLM, type LLMClient } from 'vern-llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { otelMiddleware } from '../../src/otelMiddleware.js';
import {
  createMetricHarness,
  createMockClient,
  createTraceHarness,
  FakeApiError,
  parentIdOf,
  pointsOf,
  sleep,
  spanId,
  textResponse,
  type MetricHarness,
  type TraceHarness,
} from '../helpers.js';

const CALLS = 200;

/** How call `n` behaves. Every fifth call takes the same path, so each path runs 40 times. */
const kindOf = (n: number) => n % 5;
// 0 and 4: primary answers.  1: primary fails twice, the fallback answers.
// 2: primary fails once, then answers.  3: every target fails.

const expected = (n: number) => {
  switch (kindOf(n)) {
    case 1:
      return { attempts: 3, ok: true, retries: 1, fallbacks: 1, successes: 1 };
    case 2:
      return { attempts: 2, ok: true, retries: 1, fallbacks: 0, successes: 1 };
    case 3:
      // The fallback target retries once too, so a chain that fails everywhere makes four attempts.
      return { attempts: 4, ok: false, retries: 2, fallbacks: 1, successes: 0 };
    default:
      return { attempts: 1, ok: true, retries: 0, fallbacks: 0, successes: 1 };
  }
};

const indexOf = (params: Parameters<LLMClient['chat']['completions']['create']>[0]): number => {
  const last = params.messages.at(-1);
  return Number(String(last && 'content' in last ? last.content : '').replace('call-', ''));
};

const answer = (n: number) =>
  textResponse(`answer-${n}`, {
    prompt_tokens: n + 1,
    completion_tokens: n + 2,
    total_tokens: 2 * n + 3,
  });

describe('many concurrent calls', () => {
  let trace: TraceHarness;
  let meter: MetricHarness;

  beforeEach(() => {
    trace = createTraceHarness();
    meter = createMetricHarness();
  });

  afterEach(async () => {
    await Promise.all([trace.shutdown(), meter.shutdown()]);
  });

  it('keeps every call, attempt, and measurement separate', async () => {
    const seen = new Map<number, number>();

    const primary = createMockClient([
      async (params: Parameters<LLMClient['chat']['completions']['create']>[0]) => {
        const n = indexOf(params);
        const attempt = (seen.get(n) ?? 0) + 1;
        seen.set(n, attempt);
        await sleep((n * 7) % 13);

        if (kindOf(n) === 1 || kindOf(n) === 3 || (kindOf(n) === 2 && attempt === 1)) {
          throw new FakeApiError(`primary down for ${n}`, 500);
        }
        return answer(n);
      },
    ]).client;

    const fallback = createMockClient([
      async (params: Parameters<LLMClient['chat']['completions']['create']>[0]) => {
        const n = indexOf(params);
        await sleep((n * 5) % 11);
        if (kindOf(n) === 3) throw new FakeApiError(`fallback down for ${n}`, 500);
        return answer(n);
      },
    ]).client;

    const llm = new VernLLM({
      model: 'gpt-4o',
      maxRetries: 1,
      baseDelayMs: 1,
      logger: 'silent',
      client: primary,
      fallback: { client: fallback, model: 'claude-x' },
      middleware: [
        otelMiddleware({
          tracer: trace.tracer,
          meter: meter.meter,
          logger: 'silent',
          providerNames: { primary: 'openai', 'fallback[0]': 'anthropic' },
        }),
      ],
    });

    const results = await Promise.allSettled(
      Array.from({ length: CALLS }, (_, n) =>
        llm.call({ userContent: `call-${n}`, requestId: `call-${n}`, jsonMode: false }),
      ),
    );

    // The callers got exactly what each path produces.
    results.forEach((result, n) => {
      if (expected(n).ok) {
        expect(result).toEqual({ status: 'fulfilled', value: `answer-${n}` });
      } else {
        expect(result.status).toBe('rejected');
      }
    });

    const spans = trace.spans();
    expect(trace.openSpans()).toEqual([]);

    const calls = spans.filter((span) => span.name === 'vernllm.call');
    expect(calls).toHaveLength(CALLS);
    expect(new Set(calls.map((span) => span.attributes['vernllm.request_id'])).size).toBe(CALLS);

    const attempts = spans.filter((span) => span.name !== 'vernllm.call');
    const childrenOf = new Map<string, typeof attempts>();
    for (const attempt of attempts) {
      const key = parentIdOf(attempt)!;
      childrenOf.set(key, [...(childrenOf.get(key) ?? []), attempt]);
    }

    for (const callSpan of calls) {
      const n = Number(String(callSpan.attributes['vernllm.request_id']).replace('call-', ''));
      const plan = expected(n);
      const children = childrenOf.get(spanId(callSpan)) ?? [];

      expect(children, `attempts of call ${n}`).toHaveLength(plan.attempts);
      expect(callSpan.attributes['vernllm.total_attempts']).toBe(plan.attempts);
      expect(callSpan.status.code).toBe(plan.ok ? SpanStatusCode.OK : SpanStatusCode.ERROR);

      // No attempt carries another call's tokens or failure, whatever ran alongside it.
      const answering = children.filter((child) => 'gen_ai.usage.input_tokens' in child.attributes);
      expect(answering, `answering attempts of call ${n}`).toHaveLength(plan.successes);
      for (const child of answering) {
        expect(child.attributes['gen_ai.usage.input_tokens']).toBe(n + 1);
        expect(child.attributes['gen_ai.usage.output_tokens']).toBe(n + 2);
        expect(child.status.code).toBe(SpanStatusCode.OK);
      }
      for (const child of children.filter((child) => !answering.includes(child))) {
        expect(child.status.code).toBe(SpanStatusCode.ERROR);
        expect(child.attributes['error.type']).toBe('server_error');
      }
    }

    // Exact measurement totals, from the same table.
    const sum = (pick: (plan: ReturnType<typeof expected>) => number) =>
      Array.from({ length: CALLS }, (_, n) => pick(expected(n))).reduce((a, b) => a + b, 0);

    const collected = await meter.collect();
    const total = (name: string) =>
      pointsOf(collected.get(name)).reduce(
        (acc, point) => acc + (typeof point.value === 'number' ? point.value : point.value.count),
        0,
      );

    expect(total('vernllm.call.duration')).toBe(CALLS);
    expect(total('vernllm.call.attempts')).toBe(CALLS);
    expect(total('gen_ai.client.operation.duration')).toBe(sum((plan) => plan.attempts));
    expect(total('gen_ai.client.token.usage')).toBe(2 * sum((plan) => plan.successes));
    expect(total('vernllm.retry.count')).toBe(sum((plan) => plan.retries));
    expect(total('vernllm.fallback.count')).toBe(sum((plan) => plan.fallbacks));

    // Token counts add up per call, so a measurement recorded against the wrong call would show.
    const tokens = collected.get('gen_ai.client.token.usage')!;
    const expectedTokenSum = Array.from({ length: CALLS }, (_, n) =>
      expected(n).successes === 1 ? 2 * n + 3 : 0,
    ).reduce((a, b) => a + b, 0);
    const recordedTokenSum = pointsOf(tokens).reduce(
      (acc, point) => acc + (typeof point.value === 'number' ? 0 : (point.value.sum ?? 0)),
      0,
    );
    expect(recordedTokenSum).toBe(expectedTokenSum);
  });
});
