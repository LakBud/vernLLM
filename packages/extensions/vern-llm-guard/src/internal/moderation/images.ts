import { MODERATION_NAME, type ModerationResult } from '../../detectors/openaiModeration.types.js';
import { isImage } from '../segments/isImage.utils.js';

import type { ImageSegment, Segment } from '../../types/index.js';
import type { Analyze, Hit, ImageAnalyze } from '../hosted/types.js';
import type { InputSegment } from '../segments/types.js';
import type { ModerationImageRequest } from './request.js';

/** The formats the Moderation API takes as an image. */
const FORMATS: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/** The most it takes for one image, in bytes. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Why the API cannot take this image, or `undefined` when it can. Never quotes the data. */
export function refusalFor(image: ImageSegment['image']): string | undefined {
  if (!FORMATS.has(image.mimeType.toLowerCase())) {
    return 'the API takes PNG, JPEG, WebP and GIF images only';
  }
  if (Buffer.byteLength(image.data, 'base64') > MAX_IMAGE_BYTES) {
    return 'the API takes images up to 20 MB';
  }
  return undefined;
}

export interface ImageAnalyzeConfig {
  /** Reads the text segments, as before. */
  text: Analyze;
  request: ModerationImageRequest;
  hitsOf(result: ModerationResult): Hit[];
  unsupported: 'error' | 'skip';
}

/**
 * Adds images to an analysis of text: the text goes the way it always did, and each image is its
 * own request through the same limit. The answers are put back in the order of the segments.
 */
export function withImages(config: ImageAnalyzeConfig): ImageAnalyze {
  const { text, request, hitsOf, unsupported } = config;

  const one = async (
    segment: ImageSegment,
    signal: AbortSignal,
    limit: Parameters<ImageAnalyze>[2],
  ): Promise<Hit[]> => {
    const problem = refusalFor(segment.image);
    if (problem !== undefined) {
      if (unsupported === 'skip') return [{ unscanned: true }];
      throw new Error(`${MODERATION_NAME}: ${problem}`);
    }
    return hitsOf(await limit(() => request(segment.image, signal)));
  };

  return async (segments, signal, limit) => {
    const textAt: number[] = [];
    const imageAt: number[] = [];
    segments.forEach((segment: InputSegment, index) => {
      (isImage(segment) ? imageAt : textAt).push(index);
    });

    const [texts, images] = await Promise.all([
      textAt.length === 0
        ? []
        : text(
            textAt.map((index) => segments[index] as Segment),
            signal,
            limit,
          ),
      Promise.all(imageAt.map((index) => one(segments[index] as ImageSegment, signal, limit))),
    ]);

    const hits: Hit[][] = [];
    textAt.forEach((index, at) => (hits[index] = texts[at]!));
    imageAt.forEach((index, at) => (hits[index] = images[at]!));
    return hits;
  };
}
