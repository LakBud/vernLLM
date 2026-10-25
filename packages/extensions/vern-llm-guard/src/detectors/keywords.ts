import type { Detector, Finding } from '../types/index.js';

export interface KeywordsOptions {
  /** Default `false`. */
  caseSensitive?: boolean;
}

function escape(word: string): string {
  return word.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Whole word matches of the given words or phrases. A match must not touch a letter, a digit or
 * `_`, so `cat` does not match `concatenate` but does match `cat.` and `a-cat`. The kind reported
 * is always `keyword`, so a configured word never appears in a result.
 */
export function keywords(list: readonly string[], options: KeywordsOptions = {}): Detector {
  if (list.length === 0) throw new TypeError('keywords: pass at least one word');
  for (const word of list) {
    if (typeof word !== 'string' || word.length === 0) {
      throw new TypeError('keywords: every word must be a non empty string');
    }
  }

  // Longest first, so a phrase wins over a word it contains.
  const alternatives = [...list].sort((a, b) => b.length - a.length).map(escape);
  const source = `(?<![\\p{L}\\p{N}_])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_])`;
  const flags = options.caseSensitive ? 'gu' : 'giu';

  // `matchAll` works on its own copy, so this regex is never mutated.
  const regex = new RegExp(source, flags);

  return (segments) => {
    const found: Finding[] = [];

    segments.forEach((segment, index) => {
      for (const match of segment.text.matchAll(regex)) {
        found.push({
          segment: index,
          label: 'keyword',
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    });
    return found;
  };
}
