import { groundingHitsOf, hitsOf } from './findings.js';
import { mergeSpans, splitText, type Chunk } from './hosted/chunks.js';
import { imageBlock } from './image.js';
import { sideOf, type Send } from './request.js';

import type { Analyze, Ground, GroundedSegment, Limit, Span } from './hosted/types.js';
import type { ImageSegment, Segment } from './types.js';
import type { GuardrailContentBlock } from '@aws-sdk/client-bedrock-runtime';

/** Bedrock judges up to 5000 characters of an answer in one grounding request. */
export const GROUNDING_CHUNK_CHARS = 5000;

export interface AnalyzeConfig {
  name: string;
  chunkChars: number;
  overlapChars: number;
  send: Send;
  images: boolean;
  unsupportedImages: 'error' | 'skip';
  /** Caps image requests apart from text, within the instance's own limit. */
  imageLimit: Limit;
}

/** The blocks that give an answer its context: each source as its own block, then the question. */
function groundingBlocks({ sources, query }: Ground): GuardrailContentBlock[] {
  return [
    ...sources.map((text) => ({ text: { text, qualifiers: ['grounding_source' as const] } })),
    ...(query === undefined ? [] : [{ text: { text: query, qualifiers: ['query' as const] } }]),
  ];
}

/**
 * One request per segment and chunk, at most as many at once as the limit allows. Findings are
 * shifted back to the segment's own offsets, and what two chunks both found is kept once. The
 * first failure stops the requests still waiting for a slot, before the next one starts.
 */
export function createAnalyze(config: AnalyzeConfig): Analyze {
  const { name, chunkChars, overlapChars, send, images, unsupportedImages, imageLimit } = config;

  return (segments, signal, limit) => {
    const failed = new AbortController();
    const stop = AbortSignal.any([signal, failed.signal]);
    const fail = (error: unknown): never => {
      failed.abort(error);
      throw error;
    };

    /** Runs a request in a free slot, and stops the others if it fails. */
    const slot = <T>(request: () => Promise<T>) =>
      limit(async () => {
        try {
          return await request();
        } catch (error) {
          return fail(error);
        }
      });

    /** Asks about each chunk of a text, and puts the findings on the whole text. */
    const readChunks = async (
      chunks: readonly Chunk[],
      ask: (part: string) => Promise<Span[]>,
    ): Promise<Span[]> =>
      mergeSpans(
        await Promise.all(
          chunks.map(({ offset, text }) => slot(async () => ({ offset, spans: await ask(text) }))),
        ),
      );

    const readText = ({ text, source }: Segment): Promise<Span[]> =>
      readChunks(splitText(text, chunkChars, overlapChars), async (part) =>
        hitsOf(await send(sideOf(source), [{ text: { text: part } }], stop), part),
      );

    const readGrounded = ({ text, ground }: GroundedSegment): Promise<Span[]> =>
      readChunks(splitText(text, GROUNDING_CHUNK_CHARS, 0), async (part) =>
        groundingHitsOf(
          await send('OUTPUT', [...groundingBlocks(ground), { text: { text: part } }], stop),
          part.length,
        ),
      );

    const readImage = async ({ image, source }: ImageSegment): Promise<Span[]> => {
      if (!images) fail(new TypeError(`${name}: images are off, set images: true`));

      const prepared = imageBlock(image);
      if ('refusal' in prepared) {
        if (unsupportedImages === 'skip') return [{ unscanned: true }];
        return fail(new Error(`${name}: ${prepared.refusal}`));
      }
      return imageLimit(() =>
        slot(async () => hitsOf(await send(sideOf(source), [prepared.block], stop), '')),
      );
    };

    const read = (segment: Segment | ImageSegment | GroundedSegment): Promise<Span[]> => {
      if ('image' in segment) return readImage(segment);
      if (segment.text.trim() === '') return Promise.resolve([]);
      return 'ground' in segment ? readGrounded(segment) : readText(segment);
    };

    return Promise.all(segments.map(read));
  };
}
