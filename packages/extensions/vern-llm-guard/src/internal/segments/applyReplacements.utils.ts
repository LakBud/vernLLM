import { replaceSpans } from './replaceSpans.utils.js';

import type { Extracted, Path, Replacement } from './types.js';

function setAt(node: unknown, path: Path, depth: number, value: string): unknown {
  if (depth === path.length) return value;

  const key = path[depth]!;
  if (Array.isArray(node)) {
    const copy: unknown[] = node.slice();
    copy[key as number] = setAt(node[key as number], path, depth + 1, value);
    return copy;
  }
  const record = node as Record<string, unknown>;
  return { ...record, [key]: setAt(record[key], path, depth + 1, value) };
}

/**
 * Applies replacements to a copy of `root`, the value the segments were extracted from. Only what
 * is on the way to a changed string is copied; `root` is never mutated. A replacement that overlaps
 * an earlier one in the same segment is dropped. Offsets outside the segment throw.
 */
export function applyReplacements<T>(
  root: T,
  extracted: Extracted,
  replacements: readonly Replacement[],
): T {
  const bySegment = new Map<number, Replacement[]>();
  for (const replacement of replacements) {
    const segment = extracted.segments[replacement.segment];
    if (
      segment === undefined ||
      !Number.isInteger(replacement.start) ||
      !Number.isInteger(replacement.end) ||
      replacement.start < 0 ||
      replacement.end <= replacement.start ||
      replacement.end > segment.text.length
    ) {
      throw new RangeError('a replacement lies outside its segment');
    }
    const list = bySegment.get(replacement.segment);
    if (list) list.push(replacement);
    else bySegment.set(replacement.segment, [replacement]);
  }

  let result: unknown = root;
  for (const [index, list] of bySegment) {
    const original = extracted.segments[index]!.text;
    const text = replaceSpans(original, list);

    result = setAt(result, extracted.paths[index]!, 0, text);
  }
  return result as T;
}
