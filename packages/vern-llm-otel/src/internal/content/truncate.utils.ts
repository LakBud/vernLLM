export const TRUNCATION_MARKER = '…[truncated]';

/**
 * Cuts `text` so the result, marker included, is at most `maxLength` UTF-16 units, without
 * splitting a surrogate pair. `undefined` when not even one character fits next to the marker,
 * so a caller leaves the piece out instead of emitting a marker with nothing before it.
 */
export function truncate(text: string, maxLength: number): string | undefined {
  if (text.length <= maxLength) return text;

  let end = Math.floor(maxLength) - TRUNCATION_MARKER.length;
  if (end <= 0) return undefined;

  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  if (end <= 0) return undefined;

  return text.slice(0, end) + TRUNCATION_MARKER;
}
