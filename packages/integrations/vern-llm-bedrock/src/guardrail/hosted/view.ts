import type { Detector, Finding, GuardrailDetector, GuardrailKind } from '../types.js';
import type { Lookup } from './lookup.js';

export interface ViewConfig {
  /** The detector's name, for error messages. */
  name: string;
  kinds: readonly GuardrailKind[];
  /** The kind a label belongs to. */
  kindOf(label: string): string;
  lookup: Lookup;
}

/**
 * The detector callers see: every finding numbered by its segment, and `only` for a view of some
 * kinds over the same lookup.
 */
export function createView(config: ViewConfig): GuardrailDetector {
  const { name, kinds, kindOf, lookup } = config;

  const view = (wanted?: ReadonlySet<string>): Detector => {
    return async (segments, signal): Promise<Finding[]> => {
      const found = await lookup(segments, signal);
      return found.flatMap((spans, segment) =>
        spans
          .filter((span) => wanted === undefined || wanted.has(kindOf(span.label!)))
          .map((span) => ({ segment, ...span })),
      );
    };
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
