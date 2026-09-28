import { LLMError } from 'vern-llm';

// atob and btoa exist on every runtime VernLLM targets, Node and edge alike,
// unlike Buffer. Chunking keeps String.fromCharCode under the argument limit.
const CHUNK_SIZE = 0x8000;

/** Converse takes raw image and redacted reasoning bytes, not base64 strings. */
export function decodeBase64(data: string): Uint8Array {
  let binary: string;

  try {
    binary = atob(data);
  } catch (cause) {
    throw new LLMError('Image data is not valid base64.', 'invalid_params', { cause });
  }

  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Base64 for redacted reasoning bytes, so they fit `ThinkingBlock`'s string `data`. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';

  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }

  return btoa(binary);
}
