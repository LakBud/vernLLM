import { context, type Attributes } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  MeterProvider,
  MetricReader,
  type Histogram,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type Sampler,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import type { LLMClient, LLMError, WireStreamChunk } from 'vern-llm';

// Only in memory objects here: no collector, no exporter, nothing leaves the process.

class InMemoryMetricReader extends MetricReader {
  protected override async onShutdown(): Promise<void> {}
  protected override async onForceFlush(): Promise<void> {}
}

export interface CollectedPoint<T = number | Histogram> {
  attributes: Attributes;
  value: T;
}

export interface MetricHarness {
  meter: ReturnType<MeterProvider['getMeter']>;
  provider: MeterProvider;
  /** Everything recorded so far, by metric name. */
  collect(): Promise<Map<string, MetricData>>;
  shutdown(): Promise<void>;
}

export function createMetricHarness(): MetricHarness {
  const reader = new InMemoryMetricReader();
  const provider = new MeterProvider({ readers: [reader] });

  return {
    meter: provider.getMeter('test'),
    provider,
    async collect() {
      const { resourceMetrics } = await reader.collect();
      const byName = new Map<string, MetricData>();

      for (const scope of resourceMetrics.scopeMetrics) {
        for (const metric of scope.metrics) byName.set(metric.descriptor.name, metric);
      }
      return byName;
    },
    shutdown: () => provider.shutdown(),
  };
}

export function pointsOf(metric: MetricData | undefined): CollectedPoint[] {
  if (!metric) return [];
  return metric.dataPoints.map((point) => ({
    attributes: point.attributes,
    value: point.value as number | Histogram,
  }));
}

/** Narrows a collected point to its histogram value, failing the test if it is not one. */
export function histogramOf(point: CollectedPoint | undefined): Histogram {
  if (!point || typeof point.value === 'number') throw new Error('expected a histogram point');
  return point.value;
}

// Tracing harness and a scriptable fake client. The client mirrors the shape vern-llm's own
// test helpers use, copied instead of imported so the two packages stay independent.

/** Remembers every span that started and forgets it when it ends, so a leak is visible. */
class OpenSpanTracker implements SpanProcessor {
  readonly open = new Map<string, string>();

  onStart(span: { spanContext(): { spanId: string }; name: string }): void {
    this.open.set(span.spanContext().spanId, span.name);
  }
  onEnd(span: ReadableSpan): void {
    this.open.delete(span.spanContext().spanId);
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export interface TraceHarness {
  tracer: ReturnType<BasicTracerProvider['getTracer']>;
  provider: BasicTracerProvider;
  /** Ended spans in end order. */
  spans(): ReadableSpan[];
  /** Names of spans that were started and never ended. */
  openSpans(): string[];
  shutdown(): Promise<void>;
}

export function createTraceHarness(options: { sampler?: Sampler } = {}): TraceHarness {
  const exporter = new InMemorySpanExporter();
  const tracker = new OpenSpanTracker();
  const provider = new BasicTracerProvider({
    spanProcessors: [tracker, new SimpleSpanProcessor(exporter)],
    ...(options.sampler ? { sampler: options.sampler } : {}),
  });

  return {
    tracer: provider.getTracer('test'),
    provider,
    spans: () => exporter.getFinishedSpans(),
    openSpans: () => [...tracker.open.values()],
    shutdown: () => provider.shutdown(),
  };
}

/** Installs a context manager that follows async calls, and returns how to remove it. */
export function installContextManager(): () => void {
  const manager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);

  return () => {
    context.disable();
    manager.disable();
  };
}

export function spanId(span: ReadableSpan): string {
  return span.spanContext().spanId;
}

export function parentIdOf(span: ReadableSpan): string | undefined {
  return span.parentSpanContext?.spanId;
}

/**
 * Spans ordered by start time, which is the order the calls made them in. Compared as a seconds
 * and nanoseconds pair, since their sum does not fit a double exactly. A parent that shares a
 * timestamp with its child still sorts first.
 */
export function byStart(spans: readonly ReadableSpan[]): ReadableSpan[] {
  return [...spans].sort((a, b) => {
    const byTime = a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1];
    if (byTime !== 0) return byTime;
    if (parentIdOf(b) === spanId(a)) return -1;
    if (parentIdOf(a) === spanId(b)) return 1;
    return 0;
  });
}

type CreateResult = Awaited<ReturnType<LLMClient['chat']['completions']['create']>>;
type CreateParams = Parameters<LLMClient['chat']['completions']['create']>[0];

export function textResponse(text: string, usage?: CreateResult['usage']): CreateResult {
  return { choices: [{ message: { content: text } }], usage };
}

/** An error carrying an HTTP style status, as SDK errors typically do. */
export class FakeApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

type Step =
  | CreateResult
  | Error
  | ((params: CreateParams, signal: AbortSignal) => Promise<CreateResult>);

/** Each entry is a response or an error for that call. Calls past the end reuse the last entry. */
export function createMockClient(script: Step[]) {
  const calls: CreateParams[] = [];
  let index = 0;

  const client: LLMClient = {
    chat: {
      completions: {
        create: async (params: CreateParams, options: { signal: AbortSignal }) => {
          calls.push(params);
          const entry = script[Math.min(index, script.length - 1)];
          index++;

          if (entry === undefined) throw new Error('createMockClient: script is empty');
          if (entry instanceof Error) throw entry;
          if (typeof entry === 'function') return entry(params, options.signal);
          return entry;
        },
      },
    },
  };

  return { client, calls };
}

type StreamStep = WireStreamChunk[] | Error | (() => AsyncIterable<WireStreamChunk>);

export function createMockStreamingClient(script: StreamStep[]) {
  const calls: CreateParams[] = [];
  let index = 0;

  const client: LLMClient = {
    chat: {
      completions: {
        create: async () => {
          throw new Error('createMockStreamingClient: create() was not scripted');
        },
        createStream: (params: CreateParams): AsyncIterable<WireStreamChunk> => {
          calls.push(params);
          const entry = script[Math.min(index, script.length - 1)];
          index++;

          if (entry === undefined) throw new Error('createMockStreamingClient: script is empty');
          if (typeof entry === 'function') return entry();

          return {
            [Symbol.asyncIterator]() {
              let position = 0;
              return {
                async next(): Promise<IteratorResult<WireStreamChunk>> {
                  if (entry instanceof Error) throw entry;
                  const value = entry[position++];
                  return value === undefined
                    ? { done: true, value: undefined }
                    : { done: false, value };
                },
              };
            },
          };
        },
      },
    },
  };

  return { client, calls };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

export async function settleOutcome(promise: Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

// Request ids are random per call, so they are masked before two runs are compared.
export const maskRequestIds = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (key, item) => (key === 'requestId' ? '<id>' : item)) ?? 'null');

/** What a caller can observe of an outcome, comparable between a run with and without telemetry. */
export function describeOutcome(outcome: Outcome) {
  if (outcome.ok) return { ok: true, value: maskRequestIds(outcome.value) };
  const error = outcome.error as Partial<LLMError>;
  return {
    ok: false,
    name: (error as Error).name,
    type: error.type,
    code: error.code,
    status: error.status,
    message: (error as Error).message,
  };
}
