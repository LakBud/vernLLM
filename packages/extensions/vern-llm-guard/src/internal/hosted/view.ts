import type { Detector, Finding } from '../../types/index.js';
import type { Span } from '../scan/types.js';
import type { Lookup } from './lookup.js';
import type { HostedDetector, OnlyOptions } from './types.js';

export interface ViewConfig<Kind extends string> {
  /** The detector's name, for error messages. */
  name: string;
  kinds: readonly Kind[];
  /** The kind a label belongs to. */
  kindOf(label: string): string;
  lookup: Lookup;
  /** Whether the detector also reads image segments, which its views then say too. */
  images?: boolean;
  /** Whether a label ends in a level, and `only` takes a `minLevel`. */
  levels?: boolean;
}

/** The level a label ends in, `:1` to `:3`. */
const levelOf = (label: string): number => Number(label.slice(label.lastIndexOf(':') + 1));

/** The trailing options of an `only` call, and the kinds before them. */
function parseOnly<Kind extends string>(
  name: string,
  args: readonly (Kind | OnlyOptions)[],
  levels: boolean,
): { kinds: Kind[]; minLevel: number } {
  const last = args.at(-1);
  const options = typeof last === 'object' && last !== null ? last : undefined;
  const kinds = (options === undefined ? args : args.slice(0, -1)) as Kind[];

  if (options === undefined) return { kinds, minLevel: 1 };
  if (!levels) throw new TypeError(`${name}: only() takes options only with levels: true`);

  const { minLevel = 1 } = options;
  if (!Number.isInteger(minLevel) || minLevel < 1 || minLevel > 3) {
    throw new TypeError(`${name}: minLevel must be an integer from 1 to 3`);
  }
  return { kinds, minLevel };
}

/**
 * The detector callers see: every finding numbered by its segment, and `only` for a view of some
 * kinds over the same lookup.
 */
export function createView<Kind extends string>(config: ViewConfig<Kind>): HostedDetector<Kind> {
  const { name, kinds, kindOf, lookup, images = false, levels = false } = config;

  const view = (wanted?: ReadonlySet<string>, minLevel = 1): Detector => {
    // A segment the provider could not read is passed on whatever the kinds, so it is counted.
    const keeps = (span: Span): boolean =>
      span.unscanned === true ||
      ((wanted === undefined || wanted.has(kindOf(span.label!))) &&
        (!levels || levelOf(span.label!) >= minLevel));

    const detector = async (segments: Parameters<Detector>[0], signal: AbortSignal) => {
      const found = await lookup(segments, signal);
      return found.flatMap((spans, segment): Finding[] =>
        spans.filter(keeps).map((span) => ({ segment, ...span })),
      );
    };
    return images ? Object.assign(detector, { images: true as const }) : detector;
  };

  return Object.assign(view(), {
    only(...args: (Kind | OnlyOptions)[]): Detector {
      const { kinds: wanted, minLevel } = parseOnly(name, args, levels);
      if (wanted.length === 0) throw new TypeError(`${name}: only() needs at least one kind`);
      for (const kind of wanted) {
        if (!kinds.includes(kind)) throw new TypeError(`${name}: unknown kind "${kind}"`);
      }
      return view(new Set<string>(wanted), minLevel);
    },
  });
}
