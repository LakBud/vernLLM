import { TracerProvider } from '@opentelemetry/sdk-trace';
import { VernLLM } from 'vern-llm';
import { bench, describe } from 'vitest';

import { otelMiddleware } from '../../src/index.js';
import { createMockClient, textResponse } from '../helpers.js';

// `pnpm bench` for a quick look at the cost of each setup. The number CI guards is the one from
// `pnpm bench:check`, which runs against the built package.

const call = { userContent: 'hi', jsonMode: false as const };
const dropSpans = {
  onStart() {},
  onEnd() {},
  forceFlush: async () => {},
  shutdown: async () => {},
};
const tracer = new TracerProvider({ spanProcessors: [dropSpans] }).getTracer('bench');

const make = (middleware: ReturnType<typeof otelMiddleware>[]) =>
  new VernLLM({
    client: createMockClient([textResponse('ok')]).client,
    model: 'a-model',
    maxRetries: 0,
    logger: 'silent',
    middleware,
  });

describe('a call with a fake client', () => {
  const plain = make([]);
  const noop = make([otelMiddleware({ logger: 'silent' })]);
  const recorded = make([otelMiddleware({ logger: 'silent', tracer })]);

  bench('no middleware', async () => {
    await plain.call(call);
  });
  bench('otel, no-op tracer', async () => {
    await noop.call(call);
  });
  bench('otel, recorded spans', async () => {
    await recorded.call(call);
  });
});
