import type { Span } from '../scan/types.js';

const escape = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Every place the strings occur in the text, in order, each place once. With `wholeWord` a match
 * must not touch a letter, a digit or `_`, the rule `keywords` uses.
 */
export function locate(
  text: string,
  needles: readonly string[],
  wholeWord = false,
): { start: number; end: number }[] {
  const found = new Map<string, { start: number; end: number }>();

  for (const needle of new Set(needles)) {
    if (needle.length === 0) continue;
    const body = escape(needle);
    const source = wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;

    for (const match of text.matchAll(new RegExp(source, 'gu'))) {
      const start = match.index;
      found.set(`${start}:${start + needle.length}`, { start, end: start + needle.length });
    }
  }
  return [...found.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * A finding with a span for every place a returned match occurs. A match that cannot be found in
 * the text gives a finding without one, so a `redact` check blocks rather than miss a value.
 */
export function matchSpans(
  text: string,
  label: string,
  matches: readonly string[],
  wholeWord = false,
): Span[] {
  const spans: Span[] = [];
  for (const match of new Set(matches)) {
    const places = locate(text, [match], wholeWord);
    if (places.length === 0) spans.push({ label });
    for (const place of places) spans.push({ label, ...place });
  }
  return spans;
}
