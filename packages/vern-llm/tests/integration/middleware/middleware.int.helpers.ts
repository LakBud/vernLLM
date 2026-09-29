import { createMockClient, textResponse } from '../../helpers.js';

import type { VernLLMMiddleware, VernLLMOptions } from '../../../src/types/index.js';

/** The plain text call most tests make. */
export const CALL = { userContent: 'hi', jsonMode: false as const };

export const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

/** A text response that also reports token usage, so a `usage` event fires. */
export function withUsage(text: string) {
  return { ...textResponse(text), usage: USAGE };
}

/** A `wrap` middleware that counts how many times it runs. */
export function wrapCounter(name = 'counter') {
  let count = 0;

  const middleware: VernLLMMiddleware = {
    name,
    wrap: async (_request, next) => {
      count++;
      return next();
    },
  };

  return { middleware, count: () => count };
}

/** A `wrap` middleware that records the `meta` its `next()` resolves with. */
export function metaRecorder(name = 'meta-recorder') {
  let meta: unknown;

  const middleware: VernLLMMiddleware = {
    name,
    wrap: async (_request, next) => {
      const result = await next();
      meta = result.meta;
      return result;
    },
  };

  return { middleware, meta: () => meta };
}

type Script = Parameters<typeof createMockClient>[0];

/**
 * A primary target playing `primaryScript` and one fallback playing `fallbackScript`, with retries
 * off so each target is tried once. Spread `options` into `new VernLLM`, then add what the test
 * needs. `primary` and `fallback` expose each mock client's `calls` and `create`.
 */
export function fallbackChain(primaryScript: Script, fallbackScript: Script) {
  const primary = createMockClient(primaryScript);
  const fallback = createMockClient(fallbackScript);

  const options: Pick<
    VernLLMOptions,
    'client' | 'model' | 'name' | 'maxRetries' | 'logger' | 'fallback'
  > = {
    client: primary.client,
    model: 'primary-model',
    name: 'primary',
    maxRetries: 0,
    logger: 'silent',
    fallback: { client: fallback.client, model: 'fallback-model', name: 'fallback' },
  };

  return { primary, fallback, options };
}
