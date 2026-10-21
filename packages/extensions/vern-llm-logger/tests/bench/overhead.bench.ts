import { VernLLM } from 'vern-llm';
import { bench, describe } from 'vitest';

import { loggerMiddleware } from '../../src/index.js';
import { createMockClient, textResponse } from '../helpers.js';

// `pnpm bench` for a quick look at the cost of each option. The number CI guards is the one from
// `pnpm bench:check`, which runs against the built package.

const call = { userContent: 'hi', jsonMode: false as const };
const noSink = { write: () => {} };

const make = (middleware: ReturnType<typeof loggerMiddleware>[]) =>
  new VernLLM({
    client: createMockClient([textResponse('ok')]).client,
    model: 'gpt-4o',
    logger: 'silent',
    middleware,
  });

describe('a call with a fake client', () => {
  const plain = make([]);
  const logged = make([loggerMiddleware({ sink: noSink, logger: 'silent' })]);
  const detecting = make([
    loggerMiddleware({
      sink: noSink,
      logger: 'silent',
      slowCall: { thresholdMs: 5000, aboveLivePercentile: 0.99 },
      sample: { success: 0.5 },
    }),
  ]);

  bench('no middleware', async () => {
    await plain.call(call);
  });
  bench('logger, defaults', async () => {
    await logged.call(call);
  });
  bench('logger, slow call and sampling on', async () => {
    await detecting.call(call);
  });
});
