import { VernLLM } from 'vern-llm';
import { bench, describe } from 'vitest';

import { guardMiddleware, patterns } from '../../src/index.js';

// `pnpm bench` for a quick look at the cost of each action. The number CI guards is the one from
// `pnpm bench:check`, which runs against the built package.

let serial = 0;
const nextCall = () => ({
  userContent: `Please write to jane@acme.com about invoice ${serial++}, thanks.`,
  jsonMode: false as const,
});

const ok = { choices: [{ message: { content: 'ok' } }] };
const make = (middleware: ReturnType<typeof guardMiddleware>[]) =>
  new VernLLM({
    client: { chat: { completions: { create: async () => ok } } },
    model: 'a-model',
    maxRetries: 0,
    logger: 'silent',
    middleware,
  });

describe('a call with a fake client', () => {
  const plain = make([]);
  const label = make([
    guardMiddleware({
      logger: 'silent',
      version: 'bench-1',
      checks: [{ id: 'pii', detect: patterns(['email']) }],
    }),
  ]);
  const redact = make([
    guardMiddleware({
      logger: 'silent',
      version: 'bench-1',
      checks: [{ id: 'pii', detect: patterns(['email']), action: 'redact' }],
    }),
  ]);

  bench('no middleware', async () => {
    await plain.call(nextCall());
  });
  bench('guard, label', async () => {
    await label.call(nextCall());
  });
  bench('guard, redact and restore', async () => {
    await redact.call(nextCall());
  });
});
