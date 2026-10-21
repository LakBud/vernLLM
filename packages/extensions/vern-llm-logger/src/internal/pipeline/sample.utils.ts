/** Whether a record is kept at `rate`, by a hash of its request id. */
export function shouldKeep(requestId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;

  // FNV-1a, 32 bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < requestId.length; i++) {
    hash ^= requestId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 4294967296 < rate;
}
