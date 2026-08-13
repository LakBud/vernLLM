import { LLMError } from '../../types/index.js';

/**
 * MIME types accepted for `ImageBlock.mimeType` across all adapters. This is
 * the intersection of what Anthropic, Gemini, OpenAI-compatible, and Bedrock
 * Converse all natively support, so a `ContentBlock[]` that validates for
 * one provider validates for all of them.
 */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

/**
 * Validates an `ImageBlock.mimeType` against the shared supported set.
 * Throws a non-retryable `LLMError('validation')`, since an unsupported
 * mimeType is a permanent failure, retrying the same input can't fix it,
 * the same way a schema-validation or JSON-parse failure isn't retried.
 */
export function assertSupportedImageMimeType(mimeType: string): SupportedImageMimeType {
  if ((SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return mimeType as SupportedImageMimeType;
  }

  throw new LLMError(
    `Unsupported image mimeType "${mimeType}": expected one of ${SUPPORTED_IMAGE_MIME_TYPES.join(', ')}`,
    'validation',
  );
}
