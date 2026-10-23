// Fails when the per call overhead grows past tests/bench/baseline.json.
//
//   node scripts/bench-check.ts            compare with the baseline
//   node scripts/bench-check.ts --update   record a new baseline
//
// Runs against the built package, so run `pnpm build` first.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VernLLM, type LLMClient, type VernLLMOptions } from 'vern-llm';

import { routerMiddleware } from '../dist/index.mjs';

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

const ok = { choices: [{ message: { content: 'ok' } }] };
const client = (): LLMClient => ({ chat: { completions: { create: async () => ok } } });

const targets: Pick<
  VernLLMOptions,
  'client' | 'model' | 'name' | 'maxRetries' | 'logger' | 'fallback'
> = {
  client: client(),
  model: 'a-model',
  name: 'primary',
  maxRetries: 0,
  logger: 'silent',
  fallback: [
    { client: client(), model: 'b-model', name: 'b' },
    { client: client(), model: 'c-model', name: 'c' },
  ],
};

const call = { userContent: 'hi', jsonMode: false as const, context: { tier: 'vip' } };

type Router = ReturnType<typeof routerMiddleware>;
const scenarios: Record<string, () => Router> = {
  'ordered, one route': () => routerMiddleware({ logger: 'silent', routes: [{ name: 'all' }] }),
  'weighted, matching on context': () =>
    routerMiddleware({
      logger: 'silent',
      routes: [
        {
          name: 'vip',
          when: { context: { tier: 'vip' } },
          strategy: { type: 'weighted', weights: { primary: 1, b: 2, c: 3 }, stickyBy: 'tier' },
        },
        { name: 'rest' },
      ],
    }),
  'rank on latency and cost': () => {
    const holder: { llm?: VernLLM } = {};
    const router = routerMiddleware({
      logger: 'silent',
      health: () => holder.llm as never,
      stats: { quantile: () => 800, failureRate: () => 0.01 },
      cost: () => 0.002,
      routes: [{ name: 'best', strategy: 'balanced' }],
    });
    Object.assign(router, { holder });
    return router;
  },
};

async function perCallMicros(middleware?: Router): Promise<number> {
  const llm = new VernLLM({ ...targets, middleware: middleware ? [middleware] : [] });
  const holder = (middleware as unknown as { holder?: { llm?: VernLLM } } | undefined)?.holder;
  if (holder) holder.llm = llm;
  const params = call;

  for (let i = 0; i < 1000; i++) await llm.call(params);

  const rounds: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const start = performance.now();
    for (let i = 0; i < CALLS; i++) await llm.call(params);
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

console.log(`call without the router: ${base.toFixed(1)} µs`);
for (const [name, value] of Object.entries(measured)) {
  console.log(`router overhead, ${name}: ${value} µs per call`);
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
