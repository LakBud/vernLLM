import { hitsOf } from './findings.js';
import { mergeSpans, splitText, type Chunk } from './hosted/chunks.js';

import type { Analyze, Hit } from './hosted/types.js';
import type { Ask } from './request.js';
import type { Segment, Source } from './types.js';

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

    /** Asks about one chunk in a free slot, and stops the others if it fails. */
    const askChunk = ({ offset, text }: Chunk, source: Source) =>
      limit(async () => {
        try {
          return { offset, spans: hitsOf(await ask(text, source, stop), text) };
        } catch (error) {
          failed.abort(error);
          throw error;
        }
      });

    const analyzeSegment = async ({ text, source }: Segment): Promise<Hit[]> => {
      if (text.trim() === '') return [];

      const chunks = splitText(text, chunkChars, overlapChars);
      return mergeSpans(await Promise.all(chunks.map((chunk) => askChunk(chunk, source))));
    };

    return Promise.all(segments.map(analyzeSegment));
  };
}
