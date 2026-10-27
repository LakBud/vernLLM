import { mergeSpans, splitText } from '../hosted/chunks.js';

import type { ModerationResult } from '../../detectors/openaiModeration.types.js';
import type { Segment } from '../../types/index.js';
import type { Analyze, Hit } from '../hosted/types.js';
import type { ModerationRequest } from './request.js';

export interface AnalyzeConfig {
  batchSize: number;
  chunkChars: number;
  overlapChars: number;
  request: ModerationRequest;
  hitsOf(result: ModerationResult): Hit[];
}

/** One piece of text to send, and where it belongs in the call. */
interface TextInput {
  segment: number;
  text: string;
  offset: number;
}

/** One entry per chunk of every segment that has anything in it. */
function inputsOf(
  segments: readonly Segment[],
  chunkChars: number,
  overlapChars: number,
): TextInput[] {
  return segments.flatMap((segment, index) =>
    segment.text.trim() === ''
      ? []
      : splitText(segment.text, chunkChars, overlapChars).map((chunk) => ({
          segment: index,
          ...chunk,
        })),
  );
}

/** Consecutive inputs in lists of at most `size`. */
function batchesOf<T>(inputs: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let at = 0; at < inputs.length; at += size) {
    batches.push(inputs.slice(at, at + size));
  }
  return batches;
}

/**
 * The provider's side of the detector: splits what it was given into requests, and puts the
 * answers back on the segments and chunks they came from.
 */
export function createAnalyze(config: AnalyzeConfig): Analyze {
  const { batchSize, chunkChars, overlapChars, request, hitsOf } = config;

  return async (segments, signal, limit) => {
    const inputs = inputsOf(segments, chunkChars, overlapChars);
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
      parts[input.segment]!.push({ offset: input.offset, spans: hitsOf(results[at]!) });
    });

    return parts.map((part) => mergeSpans(part));
  };
}
