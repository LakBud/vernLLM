// Fails when the cost of the whole middleware stack on one call grows past tests/bench/baseline.json.
//
//   node scripts/bench-check.ts            compare with the baseline
//   node scripts/bench-check.ts --update   record a new baseline
//
// Each package has its own baseline for itself. This one measures them stacked on the same VernLLM,
// on the path a call takes before it is dispatched: guard, usage, router, logger and otel at three
// weights, then the heavy stack with policy and hedge added to cover every middleware package.
// Runs against the built packages, so run `pnpm build` first.

import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VernLLM, type LLMClient, type VernLLMOptions } from 'vern-llm';
import { guardMiddleware, patterns } from 'vern-llm-guard';
import { hedgeMiddleware } from 'vern-llm-hedge';
import { loggerMiddleware } from 'vern-llm-logger';
import { otelMiddleware } from 'vern-llm-otel';
import { policyMiddleware } from 'vern-llm-policy';
import { routerMiddleware } from 'vern-llm-router';
import { usageMiddleware } from 'vern-llm-usage';

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

const targets: Pick<
  VernLLMOptions,
  'client' | 'model' | 'name' | 'maxRetries' | 'logger' | 'fallback' | 'defaultMaxTokens'
> = {
  client: client(),
  model: 'a-model',
  name: 'primary',
  maxRetries: 0,
  logger: 'silent',
  defaultMaxTokens: 50,
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
  context: { tenantId: 'acme', team: 'x', tier: 'vip' },
});

const prices = {
  'a-model': { input: 2, output: 10 },
  'b-model': { input: 2, output: 10 },
  'c-model': { input: 2, output: 10 },
};
const pricesAsOf = new Date().toISOString().slice(0, 10);

const noSink = { write: () => {} };
// Spans are recorded and then dropped, so a long run does not grow in memory.
const dropSpans = {
  onStart() {},
  onEnd() {},
  forceFlush: async () => {},
  shutdown: async () => {},
};
const tracer = new TracerProvider({ spanProcessors: [dropSpans] }).getTracer('bench');
const meter = new MeterProvider().getMeter('bench');

type Middleware = NonNullable<VernLLMOptions['middleware']>[number];
type Holder = { llm?: VernLLM };

const heavyStack = (holder: Holder): Middleware[] => [
  otelMiddleware({ logger: 'silent', tracer, meter, captureContent: true }),
  loggerMiddleware({
    sink: noSink,
    logger: 'silent',
    slowCall: { thresholdMs: 5000, aboveLivePercentile: 0.99 },
    sample: { success: 0.5 },
    context: ['tenantId'],
    dimensions: { tenant: (record) => record.context?.tenantId as string | undefined },
  }),
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
  usageMiddleware({
    prices,
    pricesAsOf,
    attribute: ['tenantId', 'team'],
    budgets: [
      { key: 'tenantId', limitUsd: 1e6, per: 'day' },
      { key: 'tenantId', limitTokens: 1e12, per: 'month' },
      { key: 'team', limitUsd: 1e6, per: 'day' },
    ],
    logger: 'silent',
  }),
  routerMiddleware({
    logger: 'silent',
    health: () => holder.llm as never,
    stats: { quantile: () => 800, failureRate: () => 0.01 },
    cost: () => 0.002,
    routes: [{ name: 'best', strategy: 'balanced' }],
  }),
];

// Registered outermost first: otel and logger wrap the call, guard, usage and router run before it.
// Registered outermost first: otel and logger wrap the call, guard, usage and router run before it.
const scenarios: Record<string, (holder: Holder) => Middleware[]> = {
  'light stack': () => [
    otelMiddleware({ logger: 'silent' }),
    loggerMiddleware({ sink: noSink, logger: 'silent' }),
    guardMiddleware({
      logger: 'silent',
      version: 'bench-1',
      checks: [{ id: 'pii', detect: patterns(['email']) }],
    }),
    usageMiddleware({ prices, pricesAsOf, attribute: ['tenantId', 'team'], logger: 'silent' }),
    routerMiddleware({ logger: 'silent', routes: [{ name: 'all' }] }),
  ],
  'typical stack': () => [
    otelMiddleware({ logger: 'silent', tracer }),
    loggerMiddleware({ sink: noSink, logger: 'silent' }),
    guardMiddleware({
      logger: 'silent',
      version: 'bench-1',
      checks: [{ id: 'pii', detect: patterns(['email', 'phone']), action: 'redact' }],
    }),
    usageMiddleware({
      prices,
      pricesAsOf,
      attribute: ['tenantId', 'team'],
      budgets: [{ key: 'tenantId', limitTokens: 1e12, per: 'day' }],
      logger: 'silent',
    }),
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
  ],
  'heavy stack': heavyStack,
  // The heavy stack with every other middleware added: policy filters targets after guard, and
  // hedge sits innermost, on a delay no call reaches, so it is the cost of arming and clearing it.
  'all middleware': (holder) => {
    const stack = heavyStack(holder);
    stack.splice(
      3,
      0,
      policyMiddleware({
        logger: 'silent',
        version: 'bench-1',
        targets: {
          primary: { region: 'us', zdr: false },
          b: { region: 'eu', zdr: true },
          c: { region: 'eu', zdr: false },
        },
        rules: [
          {
            id: 'eu-residency',
            forbid: { not: { region: 'eu' } },
            when: { context: { tier: 'vip' } },
          },
          { id: 'no-retention', set: { logContent: false }, when: { context: { tier: 'vip' } } },
        ],
      }),
    );
    stack.push(hedgeMiddleware({ logger: 'silent', delay: 60_000 }));
    return stack;
  },
};

async function perCallMicros(middleware: Middleware[], holder: Holder = {}): Promise<number> {
  const llm = new VernLLM({ ...targets, middleware });
  holder.llm = llm;

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
const base = await perCallMicros([]);
for (const [name, make] of Object.entries(scenarios)) {
  const holder: Holder = {};
  const stack = make(holder);
  measured[name] = Math.max(0, Math.round(((await perCallMicros(stack, holder)) - base) * 10) / 10);
  for (const middleware of stack) (middleware as { dispose?: () => void }).dispose?.();
}

console.log(`call without any middleware: ${base.toFixed(1)} µs`);
for (const [name, value] of Object.entries(measured)) {
  console.log(`stack overhead, ${name}: ${value} µs per call`);
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
