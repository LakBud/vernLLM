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

import { guardMiddleware, patterns } from '../dist/index.mjs';

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

// Every call carries text no earlier call had, so the cache and the memo never answer for it.
let serial = 0;
const nextCall = () => ({
  userContent: `Please write to jane@acme.com about invoice ${serial++}, thanks.`,
  jsonMode: false as const,
});

type Guard = ReturnType<typeof guardMiddleware>;

const scenarios: Record<string, () => Guard> = {
  'one label check': () =>
    guardMiddleware({
      logger: 'silent',
      version: 'bench-1',
      checks: [{ id: 'pii', detect: patterns(['email']) }],
    }),
  'redact with output restore': () =>
    guardMiddleware({
      logger: 'silent',
      version: 'bench-1',
      checks: [{ id: 'pii', detect: patterns(['email', 'phone']), action: 'redact' }],
    }),
  'five checks': () =>
    guardMiddleware({
      logger: 'silent',
      version: 'bench-1',
      checks: [
        { id: 'pii', detect: patterns(['email', 'phone']), action: 'redact' },
        { id: 'secrets', detect: patterns(['secrets']), action: 'block' },
        { id: 'cards', detect: patterns(['card']), action: 'label' },
        { id: 'ids', detect: patterns(['iban']), action: 'label' },
        { id: 'jwt', detect: patterns(['ip']), action: 'block' },
      ],
    }),
};

async function perCallMicros(middleware?: Guard): Promise<number> {
  const llm = new VernLLM({ ...targets, middleware: middleware ? [middleware] : [] });

  for (let i = 0; i < 1000; i++) await llm.call(nextCall());

  const rounds: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const start = performance.now();
    for (let i = 0; i < CALLS; i++) await llm.call(nextCall());
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

console.log(`call without the guard: ${base.toFixed(1)} µs`);
for (const [name, value] of Object.entries(measured)) {
  console.log(`guard overhead, ${name}: ${value} µs per call`);
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
