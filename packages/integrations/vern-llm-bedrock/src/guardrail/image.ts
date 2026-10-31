import { decodeBase64 } from '../bytes.js';

import type { GuardrailContentBlock } from '@aws-sdk/client-bedrock-runtime';

/** What Bedrock takes as an image: PNG or JPEG, up to 4 MB and 8000 by 8000 pixels. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 8000;

const FORMATS: Readonly<Record<string, 'png' | 'jpeg'>> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Big endian unsigned integers of two and four bytes. */
const u16 = (bytes: Uint8Array, at: number): number => (bytes[at]! << 8) | bytes[at + 1]!;
const u32 = (bytes: Uint8Array, at: number): number =>
  u16(bytes, at) * 0x10000 + u16(bytes, at + 2);

/** Width and height from the IHDR chunk, which must come first. */
function pngSize(bytes: Uint8Array): [number, number] | undefined {
  const signed = PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
  return signed && bytes.length >= 24 ? [u32(bytes, 16), u32(bytes, 20)] : undefined;
}

/** Width and height from the first start of frame marker, skipping the segments before it. */
function jpegSize(bytes: Uint8Array): [number, number] | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;

  let at = 2;
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    // C0 to CF are frame markers, except C4 (tables), C8 (reserved) and CC (arithmetic tables).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return [u16(bytes, at + 7), u16(bytes, at + 5)];
    }
    at += 2 + u16(bytes, at + 2);
  }
  return undefined;
}

/** The block to send, or why Bedrock cannot take the image. Never quotes the data. */
export function imageBlock(image: {
  data: string;
  mimeType: string;
}): { block: GuardrailContentBlock } | { refusal: string } {
  const format = FORMATS[image.mimeType.toLowerCase()];
  if (format === undefined) return { refusal: 'Bedrock takes PNG and JPEG images only' };

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(image.data);
  } catch {
    return { refusal: 'the image is not valid base64' };
  }
  if (bytes.length > MAX_IMAGE_BYTES) return { refusal: 'Bedrock takes images up to 4 MB' };

  const size = format === 'png' ? pngSize(bytes) : jpegSize(bytes);
  if (size === undefined) return { refusal: `the image is not a readable ${format.toUpperCase()}` };
  if (size[0] > MAX_IMAGE_SIDE || size[1] > MAX_IMAGE_SIDE) {
    return { refusal: 'Bedrock takes images up to 8000 by 8000 pixels' };
  }
  return { block: { image: { format, source: { bytes } } } };
}
