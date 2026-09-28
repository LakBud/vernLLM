import { attachRateLimitHint } from '../../internal/utils/rate-limit/rateLimitHint.utils.js';
import { unsupportedCapability } from '../internal/errors.js';
import { rateLimitHintChunk } from '../internal/rateLimitHeaders.js';
import { parseSseStream } from '../internal/sse.js';
import { toWireResponse } from './response.js';
import { toWireStreamChunks } from './stream.js';
import { openStream, readRateLimitHint, requestOnce } from './transport.js';

import type { LLMClient } from '../../types/index.js';
import type { FetchAdapterConfig } from './types.js';

/**
 * A raw HTTP adapter for providers with no SDK: supply the URL, headers,
 * and the request and response mapping. A non-2xx response throws an error
 * carrying `status` and `headers`, so retries, `nonRetryableStatus` and
 * Retry-After all apply.
 */
export function fromFetch(config: FetchAdapterConfig): LLMClient {
  return {
    adapter: {
      name: 'fetch',
      ...(typeof config.provider === 'string' && config.provider.trim() !== ''
        ? { provider: config.provider }
        : {}),
    },
    chat: {
      completions: {
        async create(params, options) {
          const res = await requestOnce(config, params, options.signal);
          const result = toWireResponse(config.mapResponse(await res.json()));

          attachRateLimitHint(result, readRateLimitHint(config, res.headers));

          return result;
        },

        async *createStream(params, options) {
          const { mapStreamEvent } = config;

          if (!mapStreamEvent) {
            throw unsupportedCapability(
              'stream: true requires mapStreamEvent to be configured on fromFetch',
              'mapStreamEvent',
            );
          }

          const parseFrames = config.parseStreamFrames ?? parseSseStream;
          const opened = await openStream(config, params, options.signal);
          const hint = readRateLimitHint(config, opened.headers);
          const hintChunk = hint && rateLimitHintChunk(hint);

          if (hintChunk) yield hintChunk;

          yield* toWireStreamChunks(parseFrames(opened.body), mapStreamEvent);
        },
      },
    },
  };
}
