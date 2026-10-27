import type { Span } from '../scan/types.js';

/** A piece of a long text, and where in the text it starts. */
export interface Chunk {
  text: string;
  offset: number;
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Splits a text into chunks of at most `size` characters, each starting `overlap` characters
 * before the previous one ended, so a value on a boundary is whole in one of them. A cut never
 * lands inside a surrogate pair. A text that fits is one chunk.
 */
export function splitText(text: string, size: number, overlap: number): Chunk[] {
  if (text.length <= size) return [{ text, offset: 0 }];

  const chunks: Chunk[] = [];
  let start = 0;
  for (;;) {
    let end = Math.min(start + size, text.length);
    if (end < text.length && isHigh(text.charCodeAt(end - 1))) end -= 1;
    chunks.push({ text: text.slice(start, end), offset: start });
    if (end >= text.length) return chunks;

    // Always moves forward, whatever the overlap.
    start = Math.max(end - overlap, start + 1);
    if (isLow(text.charCodeAt(start))) start += 1;
  }
}

/**
 * Joins what each chunk found into one list for the whole text. Offsets are shifted back by the
 * chunk's own, and a finding two chunks both made, from their overlap, is kept once.
 */
export function mergeSpans<T extends Span>(
  parts: readonly { offset: number; spans: readonly T[] }[],
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];

  for (const { offset, spans } of parts) {
    for (const span of spans) {
      const shifted =
        span.start === undefined || span.end === undefined
          ? span
          : { ...span, start: span.start + offset, end: span.end + offset };
      const key = `${shifted.label}|${shifted.start}|${shifted.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(shifted);
    }
  }
  return merged;
}
