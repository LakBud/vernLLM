/** Converse takes raw image and redacted reasoning bytes, not base64 strings. */
export function decodeBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'));
}

/** Base64 for redacted reasoning bytes, so they fit `ThinkingBlock`'s string `data`. */
export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
