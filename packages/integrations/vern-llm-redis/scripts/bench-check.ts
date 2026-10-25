// Fails when the client side cost of the Redis adapters grows past tests/bench/baseline.json.
//
//   node scripts/bench-check.ts            compare with the baseline
//   node scripts/bench-check.ts --update   record a new baseline
//
// Uses an in memory stand in for the Redis client, so the numbers are key building, JSON and
// script argument handling, never the network. Runs against the built package, so run
// `pnpm build` first.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VernLLM, type LLMClient } from 'vern-llm';

import { redisCache, redisRetryBudget, type RedisClient } from '../dist/index.mjs';

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

const reply = { choices: [{ message: { content: '{"ok":true}' } }] };
const client = (): LLMClient => ({ chat: { completions: { create: async () => reply } } });
const call = { userContent: 'hi', jsonMode: false as const };

function memoryRedis(): RedisClient {
  const data = new Map<string, string>();
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
      return 'OK';
    },
    del: async (...keys) => keys.forEach((key) => data.delete(key)),
    // Every script answers "a hundred attempts, no retries".
    eval: async () => [100, 0],
  };
}

const base = { client: client(), model: 'a-model', maxRetries: 0, logger: 'silent' as const };

type Scenario = () => () => Promise<unknown>;

const scenarios: Record<string, Scenario> = {
  'cache hit': () => {
    const llm = new VernLLM({ ...base, cache: redisCache(memoryRedis()) });
    const params = { cacheKey: 'k', ttl: 60_000, call };
    return () => llm.cachedCall(params);
  },
  'cache miss and store': () => {
    const llm = new VernLLM({ ...base, cache: redisCache(memoryRedis()) });
    let n = 0;
    return () => llm.cachedCall({ cacheKey: `k${n++}`, ttl: 60_000, call });
  },
  'retry budget': () => {
    const llm = new VernLLM({
      ...base,
      retryBudget: redisRetryBudget(memoryRedis(), {
        windowMs: 10_000,
        minCalls: 10,
        retryRatio: 0.5,
        logger: 'silent',
      }),
    });
    return () => llm.call(call);
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
process.exit(0);
