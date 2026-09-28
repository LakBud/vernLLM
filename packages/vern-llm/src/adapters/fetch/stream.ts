import { SSE_PING } from '../internal/sse.js';

import type { WireStreamChunk } from '../../types/index.js';
import type { FetchAdapterConfig } from './types.js';

/** Maps each parsed stream event through `mapStreamEvent`, skipping events it drops. */
export async function* toWireStreamChunks(
  events: AsyncIterable<unknown>,
  mapStreamEvent: NonNullable<FetchAdapterConfig['mapStreamEvent']>,
): AsyncGenerator<WireStreamChunk> {
  for await (const event of events) {
    // Handled here so `mapStreamEvent` never needs to know SSE framing.
    if (event === SSE_PING) {
      yield { type: 'ping' };
      continue;
    }

    const wireChunks = mapStreamEvent(event);

    if (!wireChunks) continue;

    if (Array.isArray(wireChunks)) {
      yield* wireChunks;
    } else {
      yield wireChunks;
    }
  }
}
