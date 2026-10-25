import type { SpanReplacement } from './types.js';

/**
 * `text` with the pieces replaced, in text order. A piece that overlaps an earlier one is dropped.
 * The pieces must lie inside `text`.
 */
export function replaceSpans(text: string, pieces: readonly SpanReplacement[]): string {
  const ordered = [...pieces].sort((a, b) => a.start - b.start);

  let result = '';
  let cursor = 0;
  for (const piece of ordered) {
    if (piece.start < cursor) continue;
    result += text.slice(cursor, piece.start) + piece.text;
    cursor = piece.end;
  }
  return result + text.slice(cursor);
}
