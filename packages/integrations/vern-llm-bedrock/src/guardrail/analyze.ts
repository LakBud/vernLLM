import { groundingHitsOf, hitsOf } from './findings.js';
import { mergeSpans, splitText, type Chunk } from './hosted/chunks.js';
import { imageBlock } from './image.js';
import { sideOf, type Send } from './request.js';

import type { Analyze, Ground, GroundedSegment, Input, Limit, Span } from './hosted/types.js';
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

/** What one call to analyze shares: the signal that stops its requests, and the slots they run in. */
interface Run {
  stop: AbortSignal;
  /** Runs a request in a free slot, and stops the others if it fails. */
  slot<T>(request: () => Promise<T>): Promise<T>;
  /** Stops the requests still waiting, and throws. */
  fail(error: unknown): never;
}

function startRun(signal: AbortSignal, limit: Limit): Run {
  const failed = new AbortController();
  const fail = (error: unknown): never => {
    failed.abort(error);
    throw error;
  };

  return {
    stop: AbortSignal.any([signal, failed.signal]),
    fail,
    slot: (request) =>
      limit(async () => {
        try {
          return await request();
        } catch (error) {
          return fail(error);
        }
      }),
  };
}

/** Asks about each chunk of a text, and puts the findings on the whole text. */
async function readChunks(
  run: Run,
  chunks: readonly Chunk[],
  ask: (part: string) => Promise<Span[]>,
): Promise<Span[]> {
  const parts = chunks.map(({ offset, text }) =>
    run.slot(async () => ({ offset, spans: await ask(text) })),
  );
  return mergeSpans(await Promise.all(parts));
}

function readText(run: Run, config: AnalyzeConfig, { text, source }: Segment): Promise<Span[]> {
  const { chunkChars, overlapChars, send } = config;

  return readChunks(run, splitText(text, chunkChars, overlapChars), async (part) =>
    hitsOf(await send(sideOf(source), [{ text: { text: part } }], run.stop), part),
  );
}

function readGrounded(run: Run, config: AnalyzeConfig, { text, ground }: GroundedSegment) {
  return readChunks(run, splitText(text, GROUNDING_CHUNK_CHARS, 0), async (part) =>
    groundingHitsOf(
      await config.send('OUTPUT', [...groundingBlocks(ground), { text: { text: part } }], run.stop),
      part.length,
    ),
  );
}

async function readImage(
  run: Run,
  config: AnalyzeConfig,
  { image, source }: ImageSegment,
): Promise<Span[]> {
  const { name, send, images, unsupportedImages, imageLimit } = config;
  if (!images) run.fail(new TypeError(`${name}: images are off, set images: true`));

  const prepared = imageBlock(image);
  if ('refusal' in prepared) {
    if (unsupportedImages === 'skip') return [{ unscanned: true }];
    return run.fail(new Error(`${name}: ${prepared.refusal}`));
  }
  return imageLimit(() =>
    run.slot(async () => hitsOf(await send(sideOf(source), [prepared.block], run.stop), '')),
  );
}

/** Reads one segment by what it is. A blank text has nothing to ask about. */
function read(run: Run, config: AnalyzeConfig, segment: Input): Promise<Span[]> {
  if ('image' in segment) return readImage(run, config, segment);
  if (segment.text.trim() === '') return Promise.resolve([]);
  return 'ground' in segment ? readGrounded(run, config, segment) : readText(run, config, segment);
}

/**
 * One request per segment and chunk, at most as many at once as the limit allows. Findings are
 * shifted back to the segment's own offsets, and what two chunks both found is kept once. The
 * first failure stops the requests still waiting for a slot, before the next one starts.
 */
export function createAnalyze(config: AnalyzeConfig): Analyze {
  return (segments, signal, limit) => {
    const run = startRun(signal, limit);
    return Promise.all(segments.map((segment) => read(run, config, segment)));
  };
}
