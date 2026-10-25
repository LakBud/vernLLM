// Fails when the cost of a call through the core grows past tests/bench/baseline.json.
//
//   node scripts/bench-check.ts            compare with the baseline
//   node scripts/bench-check.ts --update   record a new baseline
//
// Unlike the extension benches there is nothing to subtract, so the numbers are the whole call
// with a fake client. The limit is wide for that reason. Runs against the built package, so run
// `pnpm build` first.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VernLLM,
  type LLMClient,
  type VernLLMMiddleware,
  type WireStreamChunk,
} from '../dist/index.mjs';

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
const FLOOR_US = 40;

const ok = { choices: [{ message: { content: 'ok' } }] };
const good = (): LLMClient => ({ chat: { completions: { create: async () => ok } } });
const failing = (): LLMClient => ({
  chat: {
    completions: {
      create: async () => {
        throw Object.assign(new Error('down'), { status: 400 });
      },
    },
  },
});
const chunks: WireStreamChunk[] = [
  { type: 'text-delta', delta: 'hel' },
  { type: 'text-delta', delta: 'lo' },
];
const streaming = (): LLMClient => ({
  chat: {
    completions: {
      create: async () => ok,
      createStream: () => ({
        async *[Symbol.asyncIterator]() {
          yield* chunks;
        },
      }),
    },
  },
});

const base = { model: 'a-model', maxRetries: 0, logger: 'silent' as const };
const call = { userContent: 'hi', jsonMode: false as const };
const passThrough: VernLLMMiddleware = { name: 'noop', wrap: (_request, next) => next() };

type Scenario = () => () => Promise<unknown>;

const scenarios: Record<string, Scenario> = {
  'bare call': () => {
    const llm = new VernLLM({ ...base, client: good() });
    return () => llm.call(call);
  },
  'fallback after a failure': () => {
    const llm = new VernLLM({
      ...base,
      client: failing(),
      fallback: [{ client: good(), model: 'b-model', name: 'b' }],
    });
    return () => llm.call(call);
  },
  'cache hit': () => {
    const llm = new VernLLM({ ...base, client: good() });
    const params = { cacheKey: 'k', ttl: 60_000, call };
    return () => llm.cachedCall(params);
  },
  'five middleware': () => {
    const llm = new VernLLM({
      ...base,
      client: good(),
      middleware: Array.from({ length: 5 }, (_, i) => ({ ...passThrough, name: `noop-${i}` })),
    });
    return () => llm.call(call);
  },
  'stream to the end': () => {
    const llm = new VernLLM({ ...base, client: streaming() });
    return async () => {
      const result = await llm.call({ ...call, stream: true as const });
      for await (const chunk of result.chunks) void chunk;
      return result.finalResult;
    };
  },
};

async function perCallMicros(run: () => Promise<unknown>): Promise<number> {
  for (let i = 0; i < 1000; i++) await run();

  const rounds: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const start = performance.now();
    for (let i = 0; i < CALLS; i++) await run();
    rounds.push(((performance.now() - start) * 1000) / CALLS);
  }
  // The fastest round is the least disturbed by the machine.
  return Math.min(...rounds);
}

const measured: Record<string, number> = {};
for (const [name, make] of Object.entries(scenarios)) {
  measured[name] = Math.round((await perCallMicros(make())) * 10) / 10;
  console.log(`${name}: ${measured[name]} µs per call`);
}

if (process.argv.includes('--update')) {
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ unit: 'microseconds per call', calls: measured }, null, 2)}\n`,
  );
  console.log(`baseline written to ${path.relative(process.cwd(), baselinePath)}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
  calls: Record<string, number>;
};

let failed = false;
for (const [name, value] of Object.entries(measured)) {
  const recorded = baseline.calls[name];
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
console.log('cost is within the baseline');
