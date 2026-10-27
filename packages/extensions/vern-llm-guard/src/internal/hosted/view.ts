import type { Detector, Finding } from '../../types/index.js';
import type { Lookup } from './lookup.js';
import type { HostedDetector } from './types.js';

export interface ViewConfig<Kind extends string> {
  /** The detector's name, for error messages. */
  name: string;
  kinds: readonly Kind[];
  /** The kind a label belongs to. */
  kindOf(label: string): string;
  lookup: Lookup;
}

/**
 * The detector callers see: every finding numbered by its segment, and `only` for a view of some
 * kinds over the same lookup.
 */
export function createView<Kind extends string>(config: ViewConfig<Kind>): HostedDetector<Kind> {
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
    only(...wanted: Kind[]): Detector {
      if (wanted.length === 0) throw new TypeError(`${name}: only() needs at least one kind`);
      for (const kind of wanted) {
        if (!kinds.includes(kind)) throw new TypeError(`${name}: unknown kind "${kind}"`);
      }
      return view(new Set<string>(wanted));
    },
  });
}
