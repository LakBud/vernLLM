// Fails when the cost of translating a call grows past tests/bench/baseline.json.
//
//   node scripts/bench-check.ts            compare with the baseline
//   node scripts/bench-check.ts --update   record a new baseline
//
// Calls the adapter directly with a fake Bedrock client, so the numbers are the request and
// response translation plus the fake's own cost. Runs against the built package, so run
// `pnpm build` first.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fromBedrock } from '../dist/index.mjs';

import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

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

const events = [
  { messageStart: { role: 'assistant' } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hel' } } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'lo' } } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStop: { stopReason: 'end_turn' } },
  { metadata: { usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 } } },
];

const toolEvents = [
  { messageStart: { role: 'assistant' } },
  {
    contentBlockStart: {
      contentBlockIndex: 0,
      start: { toolUse: { toolUseId: 'tool_1', name: 'location' } },
    },
  },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"city":' } } } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '"Denver"}' } } } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStop: { stopReason: 'end_turn' } },
  { metadata: { usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 } } },
];

async function* replay(list: readonly unknown[]) {
  yield* list;
}

// Stands in for BedrockRuntimeClient: only `send` is called, and the command's class name says
// which API it is.
const fakeClient = {
  send: async (command: { constructor: { name: string } }) =>
    command.constructor.name === 'ConverseStreamCommand'
      ? { stream: replay(events) }
      : {
          output: { message: { content: [{ text: 'hello' }] } },
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        },
} as unknown as BedrockRuntimeClient;

const toolClient = {
  send: async () => ({ stream: replay(toolEvents) }),
} as unknown as BedrockRuntimeClient;

const model = 'anthropic.claude-3-5-sonnet-20241022-v2:0';
const signal = new AbortController().signal;
const simple = {
  model,
  max_tokens: 100,
  messages: [
    { role: 'system' as const, content: 'Be brief' },
    { role: 'user' as const, content: 'hello' },
  ],
};
const history = {
  ...simple,
  messages: [
    { role: 'system' as const, content: 'Be brief' },
    ...Array.from({ length: 10 }, (_, i) => [
      { role: 'user' as const, content: `question ${i}` },
      { role: 'assistant' as const, content: `answer ${i}` },
    ]).flat(),
    { role: 'user' as const, content: 'and now?' },
  ],
};

const drain = async (stream: AsyncIterable<unknown>) => {
  for await (const chunk of stream) void chunk;
};

type Scenario = () => () => Promise<unknown>;

const scenarios: Record<string, Scenario> = {
  'text answer': () => {
    const client = fromBedrock(fakeClient);
    return () => client.chat.completions.create(simple, { signal });
  },
  'ten turns of history': () => {
    const client = fromBedrock(fakeClient);
    return () => client.chat.completions.create(history, { signal });
  },
  'streamed text': () => {
    const client = fromBedrock(fakeClient);
    return () => drain(client.chat.completions.createStream!(simple, { signal }));
  },
  'streamed tool call': () => {
    const client = fromBedrock(toolClient);
    const params = {
      ...simple,
      response_format: {
        type: 'json_schema' as const,
        json_schema: { name: 'location', schema: { type: 'object' } },
      },
    };
    return () => drain(client.chat.completions.createStream!(params, { signal }));
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
