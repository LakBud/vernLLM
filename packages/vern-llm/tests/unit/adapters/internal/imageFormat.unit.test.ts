import { describe, it, expect } from 'vitest';

import {
  assertSupportedImageMimeType,
  SUPPORTED_IMAGE_MIME_TYPES,
} from '../../../../src/adapters/internal/imageFormat.js';
import { LLMError } from '../../../../src/types/index.js';

describe('assertSupportedImageMimeType', () => {
  it.each(SUPPORTED_IMAGE_MIME_TYPES)('returns %s unchanged when it is supported', (mimeType) => {
    expect(assertSupportedImageMimeType(mimeType)).toBe(mimeType);
  });

  it('throws an LLMError for an unsupported mimeType', () => {
    expect(() => assertSupportedImageMimeType('image/bmp')).toThrow(LLMError);
  });

  it('uses type "invalid_params" for the thrown error, since it is a caller-input bug', () => {
    try {
      assertSupportedImageMimeType('image/bmp');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LLMError);
      if (!(error instanceof LLMError)) throw error;
      expect(error.type).toBe('invalid_params');
    }
  });

  it('names the offending mimeType and lists the supported set in the error message', () => {
    try {
      assertSupportedImageMimeType('image/bmp');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LLMError);
      if (!(error instanceof LLMError)) throw error;
      expect(error.message).toContain('image/bmp');
      for (const supported of SUPPORTED_IMAGE_MIME_TYPES) {
        expect(error.message).toContain(supported);
      }
    }
  });

  it('is case-sensitive: an uppercase variant of a supported type is rejected', () => {
    expect(() => assertSupportedImageMimeType('IMAGE/PNG')).toThrow(LLMError);
  });

  it('rejects an empty string', () => {
    expect(() => assertSupportedImageMimeType('')).toThrow(LLMError);
  });

  it('is non-retryable, matching every other deterministic RequestBuilder-style validation check', () => {
    try {
      assertSupportedImageMimeType('image/bmp');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LLMError);
      if (!(error instanceof LLMError)) throw error;
      expect(error.retryable).toBe(false);
    }
  });
});
