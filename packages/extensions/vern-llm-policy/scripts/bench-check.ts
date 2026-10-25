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

import { policyMiddleware } from '../dist/index.mjs';

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

type Policy = ReturnType<typeof policyMiddleware>;

const declared = {
  primary: { region: 'us', zdr: false },
  b: { region: 'eu', zdr: true },
  c: { region: 'eu', zdr: false },
};

const scenarios: Record<string, () => Policy> = {
  'one forbid rule': () =>
    policyMiddleware({ logger: 'silent', rules: [{ id: 'no-b', forbid: { name: 'b' } }] }),
  'residency, flags and an exception': () =>
    policyMiddleware({
      logger: 'silent',
      version: 'bench-1',
      targets: declared,
      rules: [
        {
          id: 'eu-residency',
          forbid: { not: { region: 'eu' } },
          when: { context: { tier: 'vip' } },
          except: [{ when: { context: { tier: 'trial' } }, until: '2099-01-01', reason: 'bench' }],
        },
        { id: 'no-retention', set: { logContent: false }, when: { context: { tier: 'vip' } } },
        { id: 'no-small', forbid: { model: 'tiny' } },
      ],
    }),
  'twenty rules': () =>
    policyMiddleware({
      logger: 'silent',
      targets: declared,
      default: 'deny',
      rules: [
        { id: 'allow-all', allow: { region: ['us', 'eu'] } },
        ...Array.from({ length: 19 }, (_, i) => ({
          id: `rule-${String(i).padStart(2, '0')}`,
          forbid: { zdr: i % 2 === 0, name: `other-${i}` },
          when: { context: { tier: `tier-${i}` } },
        })),
      ],
    }),
};

async function perCallMicros(middleware?: Policy): Promise<number> {
  const llm = new VernLLM({ ...targets, middleware: middleware ? [middleware] : [] });
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

console.log(`call without the policy: ${base.toFixed(1)} µs`);
for (const [name, value] of Object.entries(measured)) {
  console.log(`policy overhead, ${name}: ${value} µs per call`);
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
