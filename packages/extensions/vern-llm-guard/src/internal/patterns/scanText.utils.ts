import type { Finding } from '../../types/index.js';
import type { Pattern } from './table.js';

function overlaps(spans: readonly Finding[], start: number, end: number): boolean {
  return spans.some((span) => start < span.end! && end > span.start!);
}

/** Runs every pattern over one text. Findings are ordered by position. */
export function scanText(
  text: string,
  segment: number,
  patterns: readonly (readonly [label: string, pattern: Pattern])[],
): Finding[] {
  const found: Finding[] = [];

  for (const [label, { regex, valid }] of patterns) {
    for (const match of text.matchAll(regex)) {
      const value = match[0];
      if (value.length === 0) continue;
      const start = match.index;
      const end = start + value.length;
      if (valid && !valid(value)) continue;
      if (overlaps(found, start, end)) continue;
      found.push({ segment, label, start, end });
    }
  }

  return found.sort((a, b) => a.start! - b.start!);
}
