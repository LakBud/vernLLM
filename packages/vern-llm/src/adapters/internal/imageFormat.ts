import { LLMError } from '../../types/index.js';

/**
 * `ImageBlock.mimeType` values every adapter accepts: the types all
 * supported providers share, so content valid for one is valid for all.
 */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

/** Throws a non-retryable `LLMError('invalid_params')` for a MIME type outside the shared set. */
export function assertSupportedImageMimeType(mimeType: string): SupportedImageMimeType {
  if ((SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return mimeType as SupportedImageMimeType;
  }

  throw new LLMError(
    `Unsupported image mimeType "${mimeType}": expected one of ${SUPPORTED_IMAGE_MIME_TYPES.join(', ')}`,
    'invalid_params',
  );
}
