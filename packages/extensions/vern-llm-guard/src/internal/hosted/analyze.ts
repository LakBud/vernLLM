import { mergeSpans, splitText } from './chunks.js';

import type { Segment } from '../../types/index.js';
import type { Analyze, Hit } from './types.js';

export interface AnalyzeConfig<Result> {
  batchSize: number;
  chunkChars: number;
  overlapChars: number;
  /** One request for these texts. One result per text, in order. */
  request(texts: string[], signal: AbortSignal): Promise<readonly Result[]>;
  /** Offsets are relative to `text`. */
  hitsOf(result: Result, text: string): Hit[];
}

interface TextInput {
  segment: number;
  text: string;
  offset: number;
}

function textInputs(
  segment: Segment,
  index: number,
  chunkChars: number,
  overlapChars: number,
): TextInput[] {
  if (segment.text.trim() === '') return [];
  return splitText(segment.text, chunkChars, overlapChars).map((chunk) => ({
    segment: index,
    ...chunk,
  }));
}

function batchesOf<T>(inputs: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let at = 0; at < inputs.length; at += size) {
    batches.push(inputs.slice(at, at + size));
  }
  return batches;
}

/** Splits segments into chunks and batches, and puts the answers back on their segments. */
export function createAnalyze<Result>(config: AnalyzeConfig<Result>): Analyze {
  const { batchSize, chunkChars, overlapChars, request, hitsOf } = config;

  return async (segments: readonly Segment[], signal, limit) => {
    // The guard gives an image only to a detector that asked for images, so these are all text.
    const inputs = segments.flatMap((segment, index) =>
      textInputs(segment, index, chunkChars, overlapChars),
    );
    const batches = batchesOf(inputs, batchSize);

    const answered = await Promise.all(
      batches.map((batch) =>
        limit(() =>
          request(
            batch.map((input) => input.text),
            signal,
          ),
        ),
      ),
    );
    const results = answered.flat();

    const parts = segments.map(() => [] as { offset: number; spans: Hit[] }[]);
    inputs.forEach((input, at) => {
      parts[input.segment]!.push({
        offset: input.offset,
        spans: hitsOf(results[at]!, input.text),
      });
    });

    return parts.map((part) => mergeSpans(part));
  };
}
