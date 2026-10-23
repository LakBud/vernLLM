/**
 * FNV-1a over the UTF-16 code units of `text`, mixed with a murmur3 finalizer so keys that differ
 * in a last character still spread evenly. An unsigned 32 bit integer.
 */
export function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** The same hash as a number in `[0, 1)`, to stand in for a random draw. */
export function hashUnit(text: string): number {
  return hash32(text) / 0x1_0000_0000;
}
