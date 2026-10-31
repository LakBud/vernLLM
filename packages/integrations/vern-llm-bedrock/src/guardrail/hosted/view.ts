import type { Detector, Finding, GuardrailKind, Segment } from '../types.js';
import type { Lookup } from './lookup.js';

export interface ViewConfig {
  /** The detector's name, for error messages. */
  name: string;
  kinds: readonly GuardrailKind[];
  /** The kind a label belongs to. */
  kindOf(label: string): string;
  lookup: Lookup;
  /** Whether the detectors take image segments. */
  images: boolean;
}

/**
 * The detector callers see: every finding numbered by its segment, and `only` for a view of some
 * kinds over the same lookup.
 */
export function createView(config: ViewConfig): Detector & {
  only(...wanted: GuardrailKind[]): Detector;
} {
  const { name, kinds, kindOf, lookup, images } = config;

  const view = (wanted?: ReadonlySet<string>): Detector => {
    const detect = async (
      segments: readonly Segment[],
      signal: AbortSignal,
    ): Promise<Finding[]> => {
      const found = await lookup(segments, signal);
      return found.flatMap((spans, segment) =>
        spans
          // A segment that was not read says so whatever kinds the view wants.
          .filter(
            (span) => span.unscanned || wanted === undefined || wanted.has(kindOf(span.label!)),
          )
          .map((span) => ({ segment, ...span })),
      );
    };
    return images ? Object.assign(detect, { images: true as const }) : detect;
  };

  return Object.assign(view(), {
    only(...wanted: GuardrailKind[]): Detector {
      if (wanted.length === 0) throw new TypeError(`${name}: only() needs at least one kind`);
      for (const kind of wanted) {
        if (!kinds.includes(kind)) throw new TypeError(`${name}: unknown kind "${kind}"`);
      }
      return view(new Set<string>(wanted));
    },
  });
}
