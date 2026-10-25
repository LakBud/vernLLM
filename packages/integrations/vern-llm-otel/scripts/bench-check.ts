// Fails when the per call overhead grows past tests/bench/baseline.json.
//
//   node scripts/bench-check.ts            compare with the baseline
//   node scripts/bench-check.ts --update   record a new baseline
//
// Runs against the built package, so run `pnpm build` first.

import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VernLLM, type LLMClient } from 'vern-llm';

import { otelMiddleware } from '../dist/index.mjs';

const baselinePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'bench',
  'baseline.json',
);

const CALLS = 5000;
const ROUNDS = 5;
const FACTOR = 3;
const FLOOR_US = 25;

const spent = { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 };
const reply = { choices: [{ message: { content: 'ok' } }], usage: spent };
const client = (): LLMClient => ({ chat: { completions: { create: async () => reply } } });
const call = { userContent: 'hi', jsonMode: false as const };

// Spans are recorded and then dropped, so a long run does not grow in memory.
const dropSpans = {
  onStart() {},
  onEnd() {},
  forceFlush: async () => {},
  shutdown: async () => {},
};
const tracer = new TracerProvider({ spanProcessors: [dropSpans] }).getTracer('bench');
const meter = new MeterProvider().getMeter('bench');

type Otel = ReturnType<typeof otelMiddleware>;

const scenarios: Record<string, () => Otel> = {
  'no-op tracer': () => otelMiddleware({ logger: 'silent' }),
  'recorded spans': () => otelMiddleware({ logger: 'silent', tracer }),
  'spans, metrics and content': () =>
    otelMiddleware({ logger: 'silent', tracer, meter, captureContent: true }),
};

async function perCallMicros(middleware?: Otel): Promise<number> {
  const llm = new VernLLM({
    client: client(),
    model: 'a-model',
    maxRetries: 0,
    logger: 'silent',
    middleware: middleware ? [middleware] : [],
  });

  for (let i = 0; i < 1000; i++) await llm.call(call);

  const rounds: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const start = performance.now();
    for (let i = 0; i < CALLS; i++) await llm.call(call);
    rounds.push(((performance.now() - start) * 1000) / CALLS);
  }
  // The fastest round is the least disturbed by the machine.
  return Math.min(...rounds);
}

const measured: Record<string, number> = {};
const base = await perCallMicros();
for (const [name, make] of Object.entries(scenarios)) {
  measured[name] = Math.max(0, Math.round(((await perCallMicros(make())) - base) * 10) / 10);
}

console.log(`call without otel: ${base.toFixed(1)} µs`);
for (const [name, value] of Object.entries(measured)) {
  console.log(`otel overhead, ${name}: ${value} µs per call`);
}

if (process.argv.includes('--update')) {
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ unit: 'microseconds per call', overhead: measured }, null, 2)}\n`,
  );
  console.log(`baseline written to ${path.relative(process.cwd(), baselinePath)}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
  overhead: Record<string, number>;
};

let failed = false;
for (const [name, value] of Object.entries(measured)) {
  const recorded = baseline.overhead[name];
  if (recorded === undefined) {
    console.error(`no baseline for "${name}", run with --update`);
    failed = true;
    continue;
  }
  const limit = recorded * FACTOR + FLOOR_US;
  if (value > limit) {
    console.error(
      `REGRESSION "${name}": ${value} µs per call, limit ${limit.toFixed(1)} µs (baseline ${recorded})`,
    );
    failed = true;
  }
}
if (failed) process.exit(1);
console.log('overhead is within the baseline');
