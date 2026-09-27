import type { WireRequest } from '../../../rateLimit.js';

/**
 * Tokens reserved per image by `defaultEstimateTokens`. Providers bill an
 * image by its pixel dimensions, not its base64 size, and a large image
 * lands around 1,100 to 1,600 tokens on every supported provider. The top
 * of that range errs toward over reserving, which `release` reconciles
 * against real usage anyway.
 */
const IMAGE_TOKEN_ESTIMATE = 1_600;

/** Counts text chars and images in one message's content, so base64 image data is never read as text. */
function measureContent(content: unknown): { chars: number; images: number } {
  if (typeof content === 'string') return { chars: content.length, images: 0 };
  if (content === undefined || content === null) return { chars: 0, images: 0 };

  if (Array.isArray(content)) {
    let chars = 0;
    let images = 0;

    for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
      if (block?.type === 'image') images += 1;
      else if (block?.type === 'text' && typeof block.text === 'string') chars += block.text.length;
      else chars += safeJsonLength(block);
    }

    return { chars, images };
  }

  return { chars: safeJsonLength(content), images: 0 };
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Default `estimateTokens`: chars/4 over every message's text, plus
 * `IMAGE_TOKEN_ESTIMATE` per image, plus the requested `max_tokens`.
 */
export function defaultEstimateTokens(request: WireRequest): number {
  let chars = 0;
  let images = 0;

  for (const message of request.messages) {
    const measured = measureContent((message as { content?: unknown }).content);
    chars += measured.chars;
    images += measured.images;
  }

  return Math.ceil(chars / 4) + images * IMAGE_TOKEN_ESTIMATE + (request.max_tokens ?? 0);
}
