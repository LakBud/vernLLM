import type { VernLLMMiddleware } from '../../types/middleware.js';

/**
 * A middleware's label everywhere a caller can see one: logs, the
 * `'middleware'` event, and `registeredMiddlewareNames`. `name`, or the
 * bracketed `transformOrder` position when unnamed. The brackets keep an
 * unnamed entry from ever reading like one named `"0"`.
 */
export function middlewareLabel(middleware: VernLLMMiddleware, index: number): string {
  return middleware.name ?? `[${index}]`;
}

/** `middlewareLabel` for every entry of an already ordered array. */
export function middlewareLabels(ordered: readonly VernLLMMiddleware[]): readonly string[] {
  return Object.freeze(ordered.map((entry, index) => middlewareLabel(entry, index)));
}

/** The two label lists every middleware context carries. */
export interface MiddlewareContextNames {
  registeredMiddlewareNames: readonly string[];
  transformMiddlewareNames: readonly string[];
}

/**
 * Keyed by array identity: every call site passes the same
 * `transformOrder` array, so the labels are built once per instance
 * instead of once per event or attempt.
 */
const contextNamesCache = new WeakMap<readonly VernLLMMiddleware[], MiddlewareContextNames>();

/** `registeredMiddlewareNames` and `transformMiddlewareNames` for an already ordered array. */
export function middlewareContextNames(
  ordered: readonly VernLLMMiddleware[],
): MiddlewareContextNames {
  let names = contextNamesCache.get(ordered);

  if (!names) {
    const labels = middlewareLabels(ordered);
    names = {
      registeredMiddlewareNames: labels,
      transformMiddlewareNames: Object.freeze(
        labels.filter((_, index) => ordered[index]!.transform !== undefined),
      ),
    };
    contextNamesCache.set(ordered, names);
  }

  return names;
}
