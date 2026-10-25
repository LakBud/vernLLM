import { scanText } from '../internal/patterns/scanText.utils.js';
import { ORDER, PATTERNS, type Pattern, type PatternKind } from '../internal/patterns/table.js';

import type { Detector } from '../types/index.js';

export type { PatternKind };

function globalCopy(regex: RegExp): RegExp {
  return regex.flags.includes('g') ? regex : new RegExp(regex.source, `${regex.flags}g`);
}

/**
 * A detector for common sensitive values, with validation to cut false positives: a Luhn check for
 * cards, mod 97 for IBANs, an address check for IPs. Pass kinds, or your own `{ label: RegExp }`.
 * Synchronous, so it is cheap enough to run on every stream chunk.
 *
 * These are heuristics. A phone number is any run of eight to fifteen digits that is not a date and
 * either starts with `+` or has separators, so measure with `evaluate` before you enforce.
 */
export function patterns(
  kinds: readonly PatternKind[] | Readonly<Record<string, RegExp>>,
): Detector {
  let compiled: (readonly [string, Pattern])[];

  if (Array.isArray(kinds)) {
    if (kinds.length === 0) throw new TypeError('patterns: pass at least one kind');
    for (const kind of kinds as readonly string[]) {
      if (!ORDER.includes(kind as PatternKind)) {
        throw new TypeError(`patterns: unknown kind "${kind}"`);
      }
    }
    const wanted = new Set<string>(kinds);
    compiled = ORDER.filter((kind) => wanted.has(kind)).flatMap((kind) =>
      PATTERNS[kind].map((pattern) => [kind, pattern] as const),
    );
  } else {
    const entries = Object.entries(kinds as Readonly<Record<string, RegExp>>);
    if (entries.length === 0) throw new TypeError('patterns: pass at least one pattern');
    compiled = entries.map(([label, regex]) => {
      if (!(regex instanceof RegExp)) {
        throw new TypeError(`patterns: "${label}" must be a RegExp`);
      }
      return [label, { regex: globalCopy(regex) }] as const;
    });
  }

  // `matchAll` works on its own copy of each regex, so these are never mutated and the detector
  // stays a pure function of its segments.
  return (segments) =>
    segments.flatMap((segment, index) => scanText(segment.text, index, compiled));
}
