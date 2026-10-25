import { bench, describe } from 'vitest';

import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, createMockStreamingClient, textResponse } from '../helpers.js';

// `pnpm bench` for a quick look at the cost of each path. The number CI guards is the one from
// `pnpm bench:check`, which runs against the built package.

const call = { userContent: 'hi', jsonMode: false as const };
const base = { model: 'a-model', maxRetries: 0, logger: 'silent' as const };

describe('a call with a fake client', () => {
  const plain = new VernLLM({
    ...base,
    client: createMockClient([textResponse('ok')]).client,
  });
  const cached = new VernLLM({
    ...base,
    client: createMockClient([textResponse('ok')]).client,
  });
  const streamed = new VernLLM({
    ...base,
    client: createMockStreamingClient([
      [
        { type: 'text-delta', delta: 'hel' },
        { type: 'text-delta', delta: 'lo' },
      ],
    ]).client,
  });
  const cacheParams = { cacheKey: 'k', ttl: 60_000, call };

  bench('bare call', async () => {
    await plain.call(call);
  });
  bench('cache hit', async () => {
    await cached.cachedCall(cacheParams);
  });
  bench('stream to the end', async () => {
    const result = await streamed.call({ ...call, stream: true as const });
    for await (const chunk of result.chunks) void chunk;
    await result.finalResult;
  });
});
