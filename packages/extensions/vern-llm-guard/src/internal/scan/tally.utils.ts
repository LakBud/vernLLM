import type { CompiledCheck } from '../../types/resolvedConfig.js';
import type { ScanDeps, ScanFinding, Span } from './types.js';

export interface Tally {
  /** How many findings were kept. */
  found: number;
  /** The fine labels of what was found, once each. */
  kinds: Set<string>;
  /** Findings that have no offsets, so they cannot be replaced. */
  unredactable: number;
  /** How many of the findings were in text that no earlier scan had read. */
  freshFound: number;
  kept: ScanFinding[];
}

/**
 * Counts what one check found. `spans` is by position in `positions`, which maps to segments, and
 * `todo` are the positions the detector just read, as opposed to answered from a cache.
 */
export function tally(
  check: CompiledCheck,
  spans: readonly (readonly Span[])[],
  positions: readonly number[],
  todo: readonly number[],
  skip: ScanDeps['skip'],
): Tally {
  const result: Tally = { found: 0, kinds: new Set(), unredactable: 0, freshFound: 0, kept: [] };
  const fresh = new Set(todo);

  spans.forEach((list, position) => {
    const segment = positions[position]!;
    for (const span of list) {
      if (skip?.(segment, span, check)) continue;
      result.found++;
      if (span.label !== undefined) result.kinds.add(span.label);
      if (span.start === undefined) result.unredactable++;
      if (fresh.has(position)) result.freshFound++;
      result.kept.push({ check, segment, span });
    }
  });
  return result;
}
