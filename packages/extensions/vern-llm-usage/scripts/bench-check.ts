// Fails when the per call overhead grows past tests/bench/baseline.json.
//
//   node scripts/bench-check.ts            compare with the baseline
//   node scripts/bench-check.ts --update   record a new baseline
//
// Runs against the built package, so run `pnpm build` first.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VernLLM, type LLMClient } from 'vern-llm';

import { usageMiddleware, type UsageBudget } from '../dist/index.mjs';

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

const prices = { 'a-model': { input: 2, output: 10 } };
const pricesAsOf = new Date().toISOString().slice(0, 10);
const call = {
  userContent: 'hi',
  jsonMode: false as const,
  context: { tenantId: 'acme', team: 'x' },
};

type Usage = ReturnType<typeof usageMiddleware>;

const withBudgets = (budgets: UsageBudget[]): Usage =>
  usageMiddleware({
    prices,
    pricesAsOf,
    attribute: ['tenantId', 'team'],
    budgets,
    logger: 'silent',
  });

const scenarios: Record<string, () => Usage> = {
  'attribution only': () =>
    usageMiddleware({ prices, pricesAsOf, attribute: ['tenantId', 'team'], logger: 'silent' }),
  'one token budget': () => withBudgets([{ key: 'tenantId', limitTokens: 1e12, per: 'day' }]),
  'three budgets with cost': () =>
    withBudgets([
      { key: 'tenantId', limitUsd: 1e6, per: 'day' },
      { key: 'tenantId', limitTokens: 1e12, per: 'month' },
      { key: 'team', limitUsd: 1e6, per: 'day' },
    ]),
};

async function perCallMicros(middleware?: Usage): Promise<number> {
  const llm = new VernLLM({
    client: client(),
    model: 'a-model',
    maxRetries: 0,
    logger: 'silent',
    defaultMaxTokens: 50,
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

console.log(`call without usage: ${base.toFixed(1)} µs`);
for (const [name, value] of Object.entries(measured)) {
  console.log(`usage overhead, ${name}: ${value} µs per call`);
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
