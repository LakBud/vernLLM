import { hitsOf } from './findings.js';
import { mergeSpans, splitText } from './hosted/chunks.js';

import type { Analyze } from './hosted/types.js';
import type { Ask } from './request.js';

export interface AnalyzeConfig {
  chunkChars: number;
  overlapChars: number;
  ask: Ask;
}

/**
 * One request per segment and chunk, at most as many at once as the limit allows. Findings are
 * shifted back to the segment's own offsets, and what two chunks both found is kept once. The
 * first failure stops the requests still waiting for a slot, before the next one starts.
 */
export function createAnalyze(config: AnalyzeConfig): Analyze {
  const { chunkChars, overlapChars, ask } = config;

  return (segments, signal, limit) => {
    const failed = new AbortController();
    const stop = AbortSignal.any([signal, failed.signal]);

    return Promise.all(
      segments.map(async ({ text, source }) => {
        if (text.trim() === '') return [];

        const parts = await Promise.all(
          splitText(text, chunkChars, overlapChars).map((chunk) =>
            limit(async () => {
              try {
                return {
                  offset: chunk.offset,
                  spans: hitsOf(await ask(chunk.text, source, stop), chunk.text),
                };
              } catch (error) {
                failed.abort(error);
                throw error;
              }
            }),
          ),
        );
        return mergeSpans(parts);
      }),
    );
  };
}
